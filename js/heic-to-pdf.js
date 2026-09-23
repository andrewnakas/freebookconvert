// HEIC images → single PDF. Uses heic-to (libheif WASM) to decode HEIC into a
// canvas, then pdf-lib to embed JPEGs.
(function () {
  async function convert(files, options, onProgress) {
    options = options || {};
    var quality = options.quality || 0.85;

    onProgress && onProgress(1, 'Loading converter…');
    var needsHeic = Array.prototype.some.call(files, function (f) {
      return /\.(heic|heif)$/i.test(f.name);
    });
    await (needsHeic ? CV.load('pdflib', 'heicto') : CV.load('pdflib'));

    onProgress && onProgress(2, 'Initializing…');
    var pdfDoc = await PDFLib.PDFDocument.create();
    pdfDoc.setTitle('HEIC Images');

    var total = files.length;
    for (var i = 0; i < total; i++) {
      var file = files[i];
      onProgress && onProgress(Math.floor(95 * (i / total)) + 2, 'Image ' + (i + 1) + '/' + total + '…');

      var jpegBytes;
      var isHeic = /\.(heic|heif)$/i.test(file.name) || file.type === 'image/heic' || file.type === 'image/heif';

      if (isHeic) {
        // HeicTo is exposed as a callable global by the IIFE build.
        var heicFn = (typeof window.HeicTo === 'function')
          ? window.HeicTo
          : (window.HeicTo && window.HeicTo.heicTo);
        if (!heicFn) throw new Error('HEIC decoder failed to load.');
        var jpegBlob = await heicFn({
          blob: file,
          type: 'image/jpeg',
          quality: quality
        });
        jpegBytes = new Uint8Array(await jpegBlob.arrayBuffer());
      } else {
        // Already JPEG/PNG — re-encode as JPEG for consistent sizing
        var dataUrl = await readAsDataUrl(file);
        var img = await loadImage(dataUrl);
        var canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext('2d').drawImage(img, 0, 0);
        var dataJpeg = canvas.toDataURL('image/jpeg', quality);
        var base64 = dataJpeg.split(',')[1];
        var raw = atob(base64);
        jpegBytes = new Uint8Array(raw.length);
        for (var j = 0; j < raw.length; j++) jpegBytes[j] = raw.charCodeAt(j);
      }

      var img2 = await pdfDoc.embedJpg(jpegBytes);
      var w = img2.width, h = img2.height;
      // Fit to A4 maintaining aspect ratio
      var pageW = 595.28, pageH = 841.89;
      var scale = Math.min(pageW / w, pageH / h);
      var drawW = w * scale, drawH = h * scale;
      var page = pdfDoc.addPage([pageW, pageH]);
      page.drawImage(img2, {
        x: (pageW - drawW) / 2,
        y: (pageH - drawH) / 2,
        width: drawW,
        height: drawH
      });

      // Yield to UI
      await new Promise(function (r) { setTimeout(r, 0); });
    }

    onProgress && onProgress(98, 'Encoding PDF…');
    var bytes = await pdfDoc.save();
    onProgress && onProgress(100, 'Done.');
    return new Blob([bytes], { type: 'application/pdf' });
  }

  function readAsDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }

  function loadImage(src) {
    return new Promise(function (resolve, reject) {
      var i = new Image();
      i.onload = function () { resolve(i); };
      i.onerror = reject;
      i.src = src;
    });
  }

  window.HeicToPdf = { convert: convert };
})();
