// Merge several PDFs into one, preserving page order. pdf-lib copies the page
// objects across, so text stays selectable and nothing is re-rasterised.
(function (global) {
  async function convert(files, options, onProgress) {
    options = options || {};
    onProgress = onProgress || function () {};

    if (!files || files.length < 2) {
      throw new Error('Add at least two PDFs to merge.');
    }

    onProgress(1, 'Loading converter…');
    await CV.load('pdflib');

    onProgress(2, 'Merging PDFs…');
    var merged = await PDFLib.PDFDocument.create();
    var totalPages = 0;

    for (var i = 0; i < files.length; i++) {
      onProgress(2 + Math.floor(90 * (i / files.length)),
                 'Merging ' + (i + 1) + ' / ' + files.length);
      var bytes = new Uint8Array(await files[i].arrayBuffer());
      var src;
      try {
        src = await PDFLib.PDFDocument.load(bytes);
      } catch (e) {
        throw new Error('Could not read "' + files[i].name +
                        '". If it is password-protected, remove the password first.');
      }
      var pages = await merged.copyPages(src, src.getPageIndices());
      pages.forEach(function (p) { merged.addPage(p); totalPages++; });
    }

    onProgress(95, 'Writing the file…');
    var out = await merged.save();
    onProgress(100, 'Done');

    return {
      blob: new Blob([out], { type: 'application/pdf' }),
      filename: 'merged.pdf',
      pageCount: totalPages
    };
  }

  global.MergePdf = { convert: convert };
})(window);
