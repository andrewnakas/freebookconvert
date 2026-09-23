// EPUB → PDF using pdf-lib for the document and the browser's own rendering
// pipeline (via offscreen canvas) for each "page" of laid-out HTML.
// Strategy: render each chapter into a hidden, paginated container, then
// rasterise each page to a canvas via html2canvas, then embed in PDF.
//
// We avoid html2canvas dependency by using a simpler approach: lay out text
// inside a fixed-size DIV, walk paragraph-by-paragraph, and draw text directly
// onto pdf-lib pages. This keeps output text-selectable and small.
(function () {
  var PAGE_W = 595.28;   // A4 in points
  var PAGE_H = 841.89;
  var MARGIN = 50;
  var LINE_HEIGHT = 14;
  var FONT_SIZE = 11;
  var TITLE_SIZE = 18;
  var H_SIZE = 14;

  async function convertEpubToPdf(file, onProgress) {
    onProgress && onProgress(1, 'Loading converter…');
    await CV.load('jszip', 'pdflib');

    onProgress && onProgress(2, 'Reading EPUB…');
    var epub = await EpubParser.parseEpub(file);

    onProgress && onProgress(10, 'Building PDF…');
    var pdfDoc = await PDFLib.PDFDocument.create();
    pdfDoc.setTitle(epub.title);
    pdfDoc.setAuthor(epub.author);

    var font = await pdfDoc.embedFont(PDFLib.StandardFonts.TimesRoman);
    var bold = await pdfDoc.embedFont(PDFLib.StandardFonts.TimesRomanBold);

    var ctx = { pdfDoc: pdfDoc, font: font, bold: bold, page: null, y: 0 };
    newPage(ctx);

    // Title page
    writeCentered(ctx, epub.title, bold, 26);
    ctx.y -= 20;
    writeCentered(ctx, epub.author, font, 14);
    newPage(ctx);

    var total = epub.chapters.length;
    for (var i = 0; i < total; i++) {
      var ch = epub.chapters[i];
      onProgress && onProgress(10 + Math.floor(85 * (i / total)), 'Chapter ' + (i + 1) + '/' + total + '…');
      writeChapter(ctx, ch);
      // Page break between chapters
      if (i < total - 1) newPage(ctx);
      await yieldFrame();
    }

    onProgress && onProgress(97, 'Encoding…');
    var bytes = await pdfDoc.save();
    onProgress && onProgress(100, 'Done.');
    return new Blob([bytes], { type: 'application/pdf' });
  }

  function newPage(ctx) {
    ctx.page = ctx.pdfDoc.addPage([PAGE_W, PAGE_H]);
    ctx.y = PAGE_H - MARGIN;
  }

  function ensureSpace(ctx, needed) {
    if (ctx.y - needed < MARGIN) newPage(ctx);
  }

  function writeCentered(ctx, text, font, size) {
    var lines = wrapText(text, font, size, PAGE_W - 2 * MARGIN);
    lines.forEach(function (line) {
      ensureSpace(ctx, size + 4);
      var w = font.widthOfTextAtSize(line, size);
      ctx.page.drawText(line, {
        x: (PAGE_W - w) / 2,
        y: ctx.y - size,
        size: size,
        font: font
      });
      ctx.y -= size + 4;
    });
  }

  function writeChapter(ctx, ch) {
    // Title
    if (ch.title) {
      ensureSpace(ctx, TITLE_SIZE + 10);
      ctx.page.drawText(ch.title.slice(0, 80), {
        x: MARGIN, y: ctx.y - TITLE_SIZE,
        size: TITLE_SIZE, font: ctx.bold
      });
      ctx.y -= TITLE_SIZE + 14;
    }

    // Extract blocks from HTML
    var blocks = extractBlocks(ch.html);
    blocks.forEach(function (block) {
      var size = FONT_SIZE;
      var font = ctx.font;
      if (block.tag === 'h1' || block.tag === 'h2') { size = H_SIZE; font = ctx.bold; }
      else if (block.tag === 'h3' || block.tag === 'h4') { size = FONT_SIZE + 2; font = ctx.bold; }

      var lines = wrapText(block.text, font, size, PAGE_W - 2 * MARGIN);
      lines.forEach(function (line) {
        ensureSpace(ctx, size + 4);
        ctx.page.drawText(sanitize(line), {
          x: MARGIN, y: ctx.y - size,
          size: size, font: font
        });
        ctx.y -= LINE_HEIGHT;
      });
      ctx.y -= 6; // paragraph gap
    });
  }

  function extractBlocks(html) {
    var div = document.createElement('div');
    div.innerHTML = html.replace(/<style[\s\S]*?<\/style>/gi, '')
                       .replace(/<script[\s\S]*?<\/script>/gi, '');
    var blocks = [];
    var nodes = div.querySelectorAll('h1, h2, h3, h4, h5, h6, p, li, blockquote');
    nodes.forEach(function (n) {
      var text = (n.textContent || '').replace(/\s+/g, ' ').trim();
      if (text) blocks.push({ tag: n.tagName.toLowerCase(), text: text });
    });
    if (blocks.length === 0) {
      var fallback = (div.textContent || '').replace(/\s+/g, ' ').trim();
      if (fallback) blocks.push({ tag: 'p', text: fallback });
    }
    return blocks;
  }

  function wrapText(text, font, size, maxWidth) {
    if (!text) return [];
    var words = text.split(/\s+/);
    var lines = [];
    var current = '';
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      var trial = current ? current + ' ' + w : w;
      var width;
      try { width = font.widthOfTextAtSize(sanitize(trial), size); }
      catch (e) { width = trial.length * size * 0.5; }
      if (width > maxWidth && current) {
        lines.push(current);
        current = w;
      } else {
        current = trial;
      }
    }
    if (current) lines.push(current);
    return lines;
  }

  // Standard14 fonts only support WinAnsi codepage. Drop chars they can't draw.
  function sanitize(text) {
    return text.replace(/[\u0000-\u001f]/g, '')
               .replace(/[\u2018\u2019]/g, "'")
               .replace(/[\u201c\u201d]/g, '"')
               .replace(/[\u2013\u2014]/g, '-')
               .replace(/\u2026/g, '...')
               .replace(/\u00a0/g, ' ')
               // strip any remaining non-WinAnsi-encodable codepoint
               .replace(/[^\x00-\xff]/g, '?');
  }

  function yieldFrame() {
    return new Promise(function (resolve) { setTimeout(resolve, 0); });
  }

  window.EpubToPdf = { convert: convertEpubToPdf };
})();
