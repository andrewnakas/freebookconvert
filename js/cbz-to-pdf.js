// CBZ → PDF. CBZ is a ZIP archive of images. We unpack with JSZip, sort by
// filename (natural order), then embed each image into a PDF page via pdf-lib.
(function () {
  var IMG_EXT = /\.(jpe?g|png|webp|gif|bmp)$/i;

  async function convert(file, options, onProgress) {
    options = options || {};
    var fitMode = options.fitMode || 'fit'; // fit | width | original

    onProgress && onProgress(1, 'Loading converter…');
    await CV.load('jszip', 'pdflib');

    onProgress && onProgress(2, 'Reading archive…');
    var zip = await JSZip.loadAsync(file);

    var imageEntries = [];
    zip.forEach(function (path, entry) {
      if (!entry.dir && IMG_EXT.test(path)) imageEntries.push(entry);
    });

    if (imageEntries.length === 0) throw new Error('No images found in the archive.');

    imageEntries.sort(function (a, b) {
      return naturalCompare(a.name, b.name);
    });

    onProgress && onProgress(8, 'Building PDF…');
    var pdfDoc = await PDFLib.PDFDocument.create();
    pdfDoc.setTitle(file.name.replace(/\.(cbz|zip)$/i, ''));

    var total = imageEntries.length;
    for (var i = 0; i < total; i++) {
      var entry = imageEntries[i];
      onProgress && onProgress(8 + Math.floor(88 * (i / total)), 'Page ' + (i + 1) + '/' + total);

      var bytes = await entry.async('uint8array');
      var ext = entry.name.split('.').pop().toLowerCase();

      var embedded;
      try {
        if (ext === 'png') {
          embedded = await pdfDoc.embedPng(bytes);
        } else if (ext === 'jpg' || ext === 'jpeg') {
          embedded = await pdfDoc.embedJpg(bytes);
        } else {
          // Convert via canvas to JPEG, then embed
          var jpegBytes = await reencodeToJpeg(bytes, ext);
          embedded = await pdfDoc.embedJpg(jpegBytes);
        }
      } catch (e) {
        console.warn('Skipping unreadable image: ' + entry.name, e);
        continue;
      }

      var w = embedded.width, h = embedded.height;
      var pageW, pageH, drawW, drawH, x, y;

      if (fitMode === 'original') {
        pageW = w; pageH = h;
        drawW = w; drawH = h;
        x = 0; y = 0;
      } else {
        // Fit to A4 portrait, with the image maximized
        pageW = 595.28; pageH = 841.89;
        var ratio = w / h;
        var pageRatio = pageW / pageH;
        var scale = ratio > pageRatio ? pageW / w : pageH / h;
        drawW = w * scale; drawH = h * scale;
        x = (pageW - drawW) / 2; y = (pageH - drawH) / 2;
      }

      var page = pdfDoc.addPage([pageW, pageH]);
      page.drawImage(embedded, { x: x, y: y, width: drawW, height: drawH });

      await new Promise(function (r) { setTimeout(r, 0); });
    }

    onProgress && onProgress(98, 'Encoding…');
    var pdfBytes = await pdfDoc.save();
    onProgress && onProgress(100, 'Done.');
    return new Blob([pdfBytes], { type: 'application/pdf' });
  }

  async function reencodeToJpeg(bytes, ext) {
    var blob = new Blob([bytes], { type: 'image/' + ext });
    var url = URL.createObjectURL(blob);
    try {
      var img = await new Promise(function (resolve, reject) {
        var i = new Image();
        i.onload = function () { resolve(i); };
        i.onerror = reject;
        i.src = url;
      });
      var canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d').drawImage(img, 0, 0);
      var dataUrl = canvas.toDataURL('image/jpeg', 0.88);
      var base64 = dataUrl.split(',')[1];
      var raw = atob(base64);
      var out = new Uint8Array(raw.length);
      for (var j = 0; j < raw.length; j++) out[j] = raw.charCodeAt(j);
      return out;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // Natural-order comparator so "Page 2.jpg" < "Page 10.jpg".
  function naturalCompare(a, b) {
    var ax = a.match(/(\d+|\D+)/g) || [];
    var bx = b.match(/(\d+|\D+)/g) || [];
    var len = Math.min(ax.length, bx.length);
    for (var i = 0; i < len; i++) {
      var na = parseInt(ax[i], 10), nb = parseInt(bx[i], 10);
      if (!isNaN(na) && !isNaN(nb)) {
        if (na !== nb) return na - nb;
      } else {
        var cmp = ax[i].localeCompare(bx[i]);
        if (cmp !== 0) return cmp;
      }
    }
    return ax.length - bx.length;
  }

  window.CbzToPdf = { convert: convert };
})();
