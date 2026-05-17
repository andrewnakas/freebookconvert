/*
 * PDF OCR. Rasterizes each page via pdf.js, runs Tesseract.js on it, and
 * returns either:
 *   - .txt: concatenated plain text per page, separated by form-feed
 *   - .pdf: searchable PDF (page image + invisible text layer behind it)
 *
 * Requires: window.pdfjsLib, window.Tesseract, and (for PDF output) window.PDFLib.
 */
(function (global) {
  // Tesseract.js splits its main lib, the WASM worker, and the WASM core into
  // three separate npm packages. Each lives at its own CDN path.
  var TESS_VERSION      = '5.1.1';
  var TESS_CORE_VERSION = '5.1.1';
  var TESS_DIST = 'https://cdn.jsdelivr.net/npm/tesseract.js@' + TESS_VERSION + '/dist/';
  var TESS_CORE = 'https://cdn.jsdelivr.net/npm/tesseract.js-core@' + TESS_CORE_VERSION + '/';
  var LANG_CDN  = 'https://tessdata.projectnaptha.com/4.0.0';

  async function rasterizePage(pdfPage, scale) {
    var viewport = pdfPage.getViewport({ scale: scale });
    var canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await pdfPage.render({ canvasContext: ctx, viewport: viewport }).promise;
    return canvas;
  }

  function canvasToBlob(canvas, mime, quality) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (b) {
        if (!b) return reject(new Error('canvas.toBlob failed'));
        resolve(b);
      }, mime || 'image/jpeg', quality != null ? quality : 0.85);
    });
  }

  // Create a single Tesseract worker, configured for English, that we reuse
  // across all pages of a single document.
  async function createWorker(onLog) {
    if (!global.Tesseract) throw new Error('Tesseract not loaded');
    var worker = await global.Tesseract.createWorker('eng', 1, {
      workerPath: TESS_DIST + 'worker.min.js',
      corePath:   TESS_CORE,
      langPath:   LANG_CDN,
      logger: function (m) { if (onLog) onLog(m); }
    });
    return worker;
  }

  async function ocrPage(worker, canvas) {
    var result = await worker.recognize(canvas);
    return result.data;  // .text, .words[], .lines[]
  }

  // ---------- .txt output ----------------------------------------------------

  async function convertToText(file, options, onProgress) {
    options = options || {};
    onProgress = onProgress || function () {};
    var scale = options.scale || 2;

    if (!global.pdfjsLib) throw new Error('PDF engine not loaded');

    onProgress(2, 'Reading PDF\u2026');
    var buf = await file.arrayBuffer();
    var pdf = await global.pdfjsLib.getDocument({ data: buf }).promise;
    var pageCount = pdf.numPages;

    onProgress(5, 'Loading OCR engine\u2026');
    var worker = await createWorker();

    var pages = [];
    try {
      for (var i = 1; i <= pageCount; i++) {
        var base = 10 + Math.round((i - 1) / pageCount * 85);
        onProgress(base, 'OCR page ' + i + ' / ' + pageCount + '\u2026');
        var page = await pdf.getPage(i);
        var canvas = await rasterizePage(page, scale);
        var data = await ocrPage(worker, canvas);
        pages.push((data.text || '').trim());
        canvas.width = canvas.height = 0; // free memory
        await new Promise(function (r) { setTimeout(r, 0); });
      }
    } finally {
      await worker.terminate();
    }

    onProgress(98, 'Finalizing\u2026');
    var combined = pages.join('\n\n\f\n\n'); // form-feed between pages
    var blob = new Blob([combined], { type: 'text/plain;charset=utf-8' });
    onProgress(100, 'Done');
    return {
      blob: blob,
      filename: file.name.replace(/\.pdf$/i, '') + '.txt'
    };
  }

  // ---------- searchable PDF output ------------------------------------------
  //
  // Approach: for each page, embed the rasterized page as a JPEG, then draw the
  // OCR'd words on top using a custom rendering mode that makes them invisible
  // (mode 3 = neither fill nor stroke). The text is selectable / searchable but
  // not visually rendered. We use pdf-lib's drawText with opacity 0 as a
  // simpler equivalent.

  async function convertToSearchablePdf(file, options, onProgress) {
    options = options || {};
    onProgress = onProgress || function () {};
    var scale = options.scale || 2;
    var jpegQuality = options.quality != null ? options.quality : 0.8;

    if (!global.pdfjsLib) throw new Error('PDF engine not loaded');
    if (!global.PDFLib)    throw new Error('pdf-lib not loaded');

    onProgress(2, 'Reading PDF\u2026');
    var buf = await file.arrayBuffer();
    var srcPdf = await global.pdfjsLib.getDocument({ data: buf }).promise;
    var pageCount = srcPdf.numPages;

    onProgress(5, 'Loading OCR engine\u2026');
    var worker = await createWorker();

    var outPdf = await global.PDFLib.PDFDocument.create();
    // StandardFont Helvetica is fine — we only need glyph widths for the
    // invisible layer. Real character shapes don't matter since opacity=0.
    var font = await outPdf.embedFont(global.PDFLib.StandardFonts.Helvetica);

    try {
      for (var i = 1; i <= pageCount; i++) {
        var base = 10 + Math.round((i - 1) / pageCount * 85);
        onProgress(base, 'OCR page ' + i + ' / ' + pageCount + '\u2026');

        var srcPage = await srcPdf.getPage(i);
        var canvas = await rasterizePage(srcPage, scale);
        var data = await ocrPage(worker, canvas);

        // PDF page dimensions: use the original PDF's page size in points,
        // so the searchable PDF mirrors the source layout.
        var viewport = srcPage.getViewport({ scale: 1 });
        var pageW = viewport.width;
        var pageH = viewport.height;
        var imgBlob = await canvasToBlob(canvas, 'image/jpeg', jpegQuality);
        var imgBytes = new Uint8Array(await imgBlob.arrayBuffer());
        var jpgImage = await outPdf.embedJpg(imgBytes);

        var outPage = outPdf.addPage([pageW, pageH]);
        outPage.drawImage(jpgImage, { x: 0, y: 0, width: pageW, height: pageH });

        // Map Tesseract word coords (canvas px) -> PDF points.
        var sx = pageW / canvas.width;
        var sy = pageH / canvas.height;

        var words = data.words || [];
        for (var w = 0; w < words.length; w++) {
          var word = words[w];
          if (!word.text || !word.text.trim()) continue;
          var b = word.bbox;
          if (!b) continue;
          var x = b.x0 * sx;
          // pdf-lib origin is bottom-left; canvas origin top-left.
          var y = pageH - b.y1 * sy;
          var wordH = (b.y1 - b.y0) * sy;
          var wordW = (b.x1 - b.x0) * sx;

          // Pick font size such that the rendered string roughly matches
          // the box width, falling back to the box height if the text is
          // short. This keeps the selectable region close to the visible word.
          var measured = font.widthOfTextAtSize(word.text, wordH);
          var size = wordH;
          if (measured > 0 && wordW > 0) {
            size = Math.min(wordH * 1.2, wordH * (wordW / measured));
            if (!isFinite(size) || size < 1) size = wordH;
          }

          try {
            outPage.drawText(word.text, {
              x: x,
              y: y,
              size: size,
              font: font,
              opacity: 0
            });
          } catch (_) {
            // Skip glyphs Helvetica doesn't have (rare with English).
          }
        }

        canvas.width = canvas.height = 0;
        await new Promise(function (r) { setTimeout(r, 0); });
      }
    } finally {
      await worker.terminate();
    }

    onProgress(97, 'Writing PDF\u2026');
    var bytes = await outPdf.save();
    var blob = new Blob([bytes], { type: 'application/pdf' });
    onProgress(100, 'Done');
    return {
      blob: blob,
      filename: file.name.replace(/\.pdf$/i, '') + '-ocr.pdf'
    };
  }

  // ---------- image -> text (single image OCR) ------------------------------

  async function convertImageToText(file, options, onProgress) {
    onProgress = onProgress || function () {};
    onProgress(5, 'Loading OCR engine\u2026');
    var worker = await createWorker();
    try {
      onProgress(20, 'Reading image\u2026');
      var url = URL.createObjectURL(file);
      var img = await new Promise(function (resolve, reject) {
        var i = new Image();
        i.onload = function () { resolve(i); };
        i.onerror = function () { reject(new Error('Could not decode image')); };
        i.src = url;
      });
      var canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d').drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
      onProgress(40, 'Running OCR\u2026');
      var data = await ocrPage(worker, canvas);
      canvas.width = canvas.height = 0;
      onProgress(98, 'Finalizing\u2026');
      var blob = new Blob([(data.text || '').trim()], { type: 'text/plain;charset=utf-8' });
      onProgress(100, 'Done');
      return {
        blob: blob,
        filename: file.name.replace(/\.[^.]+$/, '') + '.txt'
      };
    } finally {
      await worker.terminate();
    }
  }

  // ---------- public --------------------------------------------------------

  async function convert(file, options, onProgress) {
    options = options || {};
    var format = (options.format || 'txt').toLowerCase();
    if (format === 'pdf' || format === 'searchable-pdf') {
      return convertToSearchablePdf(file, options, onProgress);
    }
    return convertToText(file, options, onProgress);
  }

  global.PdfOcr = { convert: convert, convertImageToText: convertImageToText };
})(window);
