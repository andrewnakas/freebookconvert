// PDF → EPUB. Extract per-page text with pdf.js, group into chapters by
// detected heading-ish lines, then pack into a minimal EPUB 3 zip.
(function () {
  // Text + chapter structure only, shared with the audiobook tools.
  // onProgress receives 0-100 for the reading phase.
  async function extractChapters(file, options, onProgress) {
    options = options || {};
    var pagesPerChapter = options.pagesPerChapter || 0; // 0 = auto
    await CV.load('pdfjs');
    var data = new Uint8Array(await file.arrayBuffer());
    var pdf = await pdfjsLib.getDocument({ data: data }).promise;

    var meta = await pdf.getMetadata().catch(function () { return { info: {} }; });
    var title = (meta.info && meta.info.Title) || file.name.replace(/\.pdf$/i, '');
    var author = (meta.info && meta.info.Author) || 'Unknown';

    var totalPages = pdf.numPages;
    var pages = [];
    for (var p = 1; p <= totalPages; p++) {
      onProgress && onProgress(Math.floor(100 * (p / totalPages)), 'Reading page ' + p + '/' + totalPages);
      var page = await pdf.getPage(p);
      var tc = await page.getTextContent();
      pages.push(joinTextItems(tc.items));
      await yieldFrame();
    }

    var chapters = pagesPerChapter > 0 ? groupByCount(pages, pagesPerChapter) : groupByHeadings(pages);
    return { title: title, author: author, chapters: chapters };
  }

  async function convert(file, options, onProgress) {
    options = options || {};
    onProgress && onProgress(1, 'Loading converter…');
    await CV.load('jszip');
    onProgress && onProgress(2, 'Loading PDF…');
    var book = await extractChapters(file, options, function (pct, msg) {
      onProgress && onProgress(2 + Math.floor(0.7 * pct), msg);
    });

    onProgress && onProgress(85, 'Building EPUB…');
    var blob = await buildEpub(book);
    onProgress && onProgress(100, 'Done.');
    return blob;
  }

  function joinTextItems(items) {
    // pdf.js gives items with a transform. Use the Y component (transform[5])
    // to detect line breaks.
    var lines = [];
    var lastY = null;
    var current = '';
    items.forEach(function (it) {
      var y = it.transform ? it.transform[5] : null;
      if (lastY === null) lastY = y;
      if (y !== null && lastY !== null && Math.abs(y - lastY) > 4) {
        if (current.trim()) lines.push(current.trim());
        current = '';
        lastY = y;
      }
      current += it.str;
      if (it.hasEOL) {
        if (current.trim()) lines.push(current.trim());
        current = '';
      }
    });
    if (current.trim()) lines.push(current.trim());
    return lines;
  }

  function looksLikeHeading(line, idx, allLines) {
    if (!line) return false;
    if (line.length > 90) return false;
    if (/^(chapter|prologue|epilogue|introduction|part)\b/i.test(line)) return true;
    if (/^\s*chapter\s+\d/i.test(line)) return true;
    if (/^\d+\s*\.\s*[A-Z]/.test(line) && line.length < 60) return true;
    return false;
  }

  function groupByHeadings(pages) {
    var chapters = [];
    var current = { title: 'Beginning', paragraphs: [] };
    pages.forEach(function (lines, pIdx) {
      lines.forEach(function (line, lIdx) {
        if (looksLikeHeading(line, lIdx, lines)) {
          if (current.paragraphs.length) chapters.push(current);
          current = { title: line, paragraphs: [] };
        } else {
          current.paragraphs.push(line);
        }
      });
    });
    if (current.paragraphs.length) chapters.push(current);
    if (chapters.length === 0) {
      chapters.push({ title: 'Content', paragraphs: flatten(pages) });
    }
    return chapters;
  }

  function groupByCount(pages, pagesPerChapter) {
    var chapters = [];
    for (var i = 0; i < pages.length; i += pagesPerChapter) {
      var slice = pages.slice(i, i + pagesPerChapter);
      chapters.push({
        title: 'Chapter ' + (chapters.length + 1),
        paragraphs: flatten(slice)
      });
    }
    return chapters;
  }

  function flatten(pages) {
    var out = [];
    pages.forEach(function (lines) { lines.forEach(function (l) { out.push(l); }); });
    return out;
  }

  async function buildEpub(book) {
    var zip = new JSZip();
    zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });

    zip.file('META-INF/container.xml',
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n' +
      '  <rootfiles>\n' +
      '    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>\n' +
      '  </rootfiles>\n' +
      '</container>\n');

    var manifestItems = [];
    var spineItems = [];
    var navList = [];

    book.chapters.forEach(function (ch, idx) {
      var id = 'ch' + (idx + 1);
      var fname = id + '.xhtml';
      var html = chapterToXhtml(ch);
      zip.file('OEBPS/' + fname, html);
      manifestItems.push('<item id="' + id + '" href="' + fname + '" media-type="application/xhtml+xml"/>');
      spineItems.push('<itemref idref="' + id + '"/>');
      navList.push('<li><a href="' + fname + '">' + escapeXml(ch.title) + '</a></li>');
    });

    var nav = '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<!DOCTYPE html>\n' +
      '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">\n' +
      '<head><meta charset="utf-8"/><title>Contents</title></head>\n' +
      '<body><nav epub:type="toc" id="toc"><h1>Contents</h1><ol>' + navList.join('') + '</ol></nav></body></html>\n';
    zip.file('OEBPS/nav.xhtml', nav);
    manifestItems.push('<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>');

    var uuid = 'urn:uuid:' + cryptoRandomUuid();
    var opf = '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">\n' +
      '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n' +
      '    <dc:identifier id="bookid">' + uuid + '</dc:identifier>\n' +
      '    <dc:title>' + escapeXml(book.title) + '</dc:title>\n' +
      '    <dc:creator>' + escapeXml(book.author) + '</dc:creator>\n' +
      '    <dc:language>en</dc:language>\n' +
      '    <meta property="dcterms:modified">' + new Date().toISOString().replace(/\.\d+/, '') + '</meta>\n' +
      '  </metadata>\n' +
      '  <manifest>\n    ' + manifestItems.join('\n    ') + '\n  </manifest>\n' +
      '  <spine>\n    ' + spineItems.join('\n    ') + '\n  </spine>\n' +
      '</package>\n';
    zip.file('OEBPS/content.opf', opf);

    var blob = await zip.generateAsync({
      type: 'blob',
      mimeType: 'application/epub+zip',
      compression: 'DEFLATE'
    });
    return blob;
  }

  function chapterToXhtml(ch) {
    var body = ch.paragraphs.map(function (p) {
      return '<p>' + escapeXml(p) + '</p>';
    }).join('\n');
    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<!DOCTYPE html>\n' +
      '<html xmlns="http://www.w3.org/1999/xhtml">\n' +
      '<head><meta charset="utf-8"/><title>' + escapeXml(ch.title) + '</title></head>\n' +
      '<body>\n  <h1>' + escapeXml(ch.title) + '</h1>\n  ' + body + '\n</body>\n</html>\n';
  }

  function escapeXml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }

  function cryptoRandomUuid() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0, v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function yieldFrame() {
    return new Promise(function (r) { setTimeout(r, 0); });
  }

  window.PdfToEpub = { convert: convert, extractChapters: extractChapters };
})();
