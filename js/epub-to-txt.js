// EPUB → plain text. Concatenates all chapters with chapter title separators.
(function () {
  async function convert(file, onProgress) {
    onProgress && onProgress(1, 'Loading converter…');
    await CV.load('jszip');

    onProgress && onProgress(5, 'Reading EPUB…');
    var epub = await EpubParser.parseEpub(file);

    onProgress && onProgress(15, 'Extracting text…');
    var out = [];
    out.push(epub.title);
    out.push('by ' + epub.author);
    out.push('');
    out.push('');

    var total = epub.chapters.length;
    for (var i = 0; i < total; i++) {
      var ch = epub.chapters[i];
      onProgress && onProgress(15 + Math.floor(80 * (i / total)), 'Chapter ' + (i + 1) + '/' + total);
      if (ch.title) {
        out.push('');
        out.push('=== ' + ch.title + ' ===');
        out.push('');
      }
      out.push(EpubParser.htmlToText(ch.html));
      out.push('');
      if (i % 5 === 0) await new Promise(function (r) { setTimeout(r, 0); });
    }

    onProgress && onProgress(100, 'Done.');
    var text = out.join('\n');
    return new Blob([text], { type: 'text/plain;charset=utf-8' });
  }

  window.EpubToTxt = { convert: convert };
})();
