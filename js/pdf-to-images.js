/*
 * PDF -> JPG/PNG images. Renders each page via pdf.js, packages as ZIP if >1 page.
 * Requires window.pdfjsLib + window.JSZip.
 */
(function (global) {
  async function convert(file, options, onProgress) {
    options = options || {};
    onProgress = onProgress || function () {};
    var format = (options.format || 'jpg').toLowerCase();
    var mime = format === 'png' ? 'image/png' : 'image/jpeg';
    var quality = options.quality != null ? options.quality : 0.92;
    var scale = options.scale || 2; // 2x for sharp output

    if (!global.pdfjsLib) throw new Error('PDF engine not loaded');
    if (!global.JSZip) throw new Error('JSZip not loaded');

    onProgress(2, 'Reading PDF\u2026');
    var buf = await file.arrayBuffer();
    var pdf = await global.pdfjsLib.getDocument({ data: buf }).promise;
    var pageCount = pdf.numPages;
    var baseName = file.name.replace(/\.pdf$/i, '');

    var zip = new global.JSZip();
    var folder = zip.folder(baseName);

    for (var i = 1; i <= pageCount; i++) {
      onProgress(Math.round((i - 1) / pageCount * 90) + 5, 'Page ' + i + ' / ' + pageCount);
      var page = await pdf.getPage(i);
      var viewport = page.getViewport({ scale: scale });
      var canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      var ctx = canvas.getContext('2d');
      if (format !== 'png') {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      await page.render({ canvasContext: ctx, viewport: viewport }).promise;
      var blob = await new Promise(function (resolve, reject) {
        canvas.toBlob(function (b) {
          if (!b) return reject(new Error('Failed to encode page ' + i));
          resolve(b);
        }, mime, quality);
      });
      var pad = String(i).padStart(String(pageCount).length, '0');
      folder.file(baseName + '-page-' + pad + '.' + format, blob);

      // Yield to UI
      await new Promise(function (r) { setTimeout(r, 0); });
    }

    if (pageCount === 1) {
      // Single page: return the image directly, not a ZIP
      onProgress(98, 'Finalizing\u2026');
      var entry = folder.files[Object.keys(folder.files)[0]] || zip.files[Object.keys(zip.files).filter(function (k) { return !zip.files[k].dir; })[0]];
      var singleBlob = await entry.async('blob');
      onProgress(100, 'Done');
      return {
        blob: new Blob([await singleBlob.arrayBuffer()], { type: mime }),
        filename: baseName + '.' + format,
        isZip: false
      };
    }

    onProgress(96, 'Packaging ZIP\u2026');
    var zipBlob = await zip.generateAsync({ type: 'blob' });
    onProgress(100, 'Done');
    return { blob: zipBlob, filename: baseName + '-pages.zip', isZip: true };
  }

  global.PdfToImages = { convert: convert };
})(window);
