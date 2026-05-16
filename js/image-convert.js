/*
 * Shared image conversion helpers.
 * Decode source (raster image or HEIC) -> canvas -> re-encode as target type.
 *
 * Requires window.HeicTo (only for HEIC inputs) and window.JSZip (for batch ZIP).
 */
(function (global) {
  var TYPE_MAP = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp'
  };

  function extToMime(ext) { return TYPE_MAP[ext.toLowerCase()] || 'image/png'; }

  function loadImageFromBlob(blob) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Could not decode image')); };
      img.src = url;
    });
  }

  // Returns an HTMLImageElement for any supported input (HEIC decoded to JPEG first).
  async function decodeImage(file) {
    var lower = file.name.toLowerCase();
    if (lower.endsWith('.heic') || lower.endsWith('.heif') || file.type === 'image/heic' || file.type === 'image/heif') {
      if (!global.HeicTo) throw new Error('HEIC decoder not loaded');
      var jpegBlob = await global.HeicTo({ blob: file, type: 'image/jpeg', quality: 0.95 });
      return loadImageFromBlob(jpegBlob);
    }
    return loadImageFromBlob(file);
  }

  function canvasToBlob(canvas, mime, quality) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (b) {
        if (!b) return reject(new Error('Encoding failed (browser may not support ' + mime + ')'));
        resolve(b);
      }, mime, quality);
    });
  }

  // Convert one file to the target extension; returns a Blob.
  async function convertOne(file, targetExt, opts) {
    opts = opts || {};
    var img = await decodeImage(file);
    var w = img.naturalWidth, h = img.naturalHeight;
    if (opts.maxDim && Math.max(w, h) > opts.maxDim) {
      var s = opts.maxDim / Math.max(w, h);
      w = Math.round(w * s); h = Math.round(h * s);
    }
    var canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    var ctx = canvas.getContext('2d');
    // JPEG has no alpha; paint a white background so transparent PNGs don't go black.
    if (targetExt === 'jpg' || targetExt === 'jpeg') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
    }
    ctx.drawImage(img, 0, 0, w, h);
    return canvasToBlob(canvas, extToMime(targetExt), opts.quality != null ? opts.quality : 0.92);
  }

  function replaceExt(name, newExt) {
    return name.replace(/\.[^.]+$/, '') + '.' + newExt;
  }

  // Batch convert; returns either a single Blob (1 file) or a ZIP Blob (>1 file).
  async function convertBatch(files, targetExt, opts, onProgress) {
    opts = opts || {};
    onProgress = onProgress || function () {};
    if (files.length === 0) throw new Error('No files');

    if (files.length === 1) {
      onProgress(10, 'Decoding\u2026');
      var blob = await convertOne(files[0], targetExt, opts);
      onProgress(100, 'Done');
      return { blob: blob, filename: replaceExt(files[0].name, targetExt), isZip: false };
    }

    if (!global.JSZip) throw new Error('JSZip not loaded (needed for batch)');
    var zip = new global.JSZip();
    var total = files.length;
    for (var i = 0; i < total; i++) {
      var f = files[i];
      onProgress(Math.round((i / total) * 90) + 5, 'Converting ' + (i + 1) + ' / ' + total);
      var b = await convertOne(f, targetExt, opts);
      zip.file(replaceExt(f.name, targetExt), b);
    }
    onProgress(95, 'Packaging ZIP\u2026');
    var zipBlob = await zip.generateAsync({ type: 'blob' });
    onProgress(100, 'Done');
    var stamp = new Date().toISOString().slice(0, 10);
    return { blob: zipBlob, filename: 'images-' + stamp + '.zip', isZip: true };
  }

  global.ImageConvert = {
    convertOne: convertOne,
    convertBatch: convertBatch,
    replaceExt: replaceExt
  };
})(window);
