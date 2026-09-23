/*
 * Turns an EPUB, PDF, or TXT into plain-text chapters for the listening tools
 * (read-aloud and ebook-to-audiobook), plus the sentence chunking both need.
 *
 * EPUB: needs js/epub-parser.js on the page. PDF: needs js/pdf-to-epub.js.
 */
(function (global) {
  var BLOCK = 'p,h1,h2,h3,h4,h5,h6,li,blockquote,div,section,article,tr,dt,dd,pre,figcaption';

  // DOMParser documents are inert: no image fetches, no scripts. (Setting
  // innerHTML on a live element would request every <img> in the chapter.)
  function htmlToText(html) {
    var doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script,style,noscript,svg,math,rt,sup.footnote,a.noteref').forEach(function (n) { n.remove(); });
    doc.querySelectorAll('br').forEach(function (b) { b.replaceWith('\n'); });
    doc.querySelectorAll(BLOCK).forEach(function (b) { b.insertAdjacentText('afterend', '\n\n'); });
    var body = doc.body || doc.documentElement;
    return tidy(body.textContent || '');
  }

  function firstHeading(html) {
    var doc = new DOMParser().parseFromString(html, 'text/html');
    var h = doc.querySelector('h1,h2,h3');
    var t = h && h.textContent.replace(/\s+/g, ' ').trim();
    return t && t.length <= 120 ? t : null;
  }

  function tidy(text) {
    return text
      .replace(/­/g, '')                 // soft hyphens
      .replace(/[ \t ]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function wordCount(text) {
    var m = text.match(/\S+/g);
    return m ? m.length : 0;
  }

  // ---------- loaders ----------------------------------------------------------

  async function fromEpub(file) {
    await CV.load('jszip');
    var book = await EpubParser.parseEpub(file);
    var chapters = book.chapters.map(function (c, i) {
      var text = htmlToText(c.html);
      var title = firstHeading(c.html);
      if (!title && c.title && c.title !== book.title && c.title !== c.id) title = c.title;
      return { title: title || 'Section ' + (i + 1), text: text };
    });
    return { title: book.title, author: book.author, language: book.language, chapters: chapters };
  }

  async function fromPdf(file, onProgress) {
    var book = await PdfToEpub.extractChapters(file, {}, onProgress);
    var chapters = book.chapters.map(function (c) {
      // PDF text arrives as visual lines. Re-join them, mending words that were
      // hyphenated across a line break.
      var text = c.paragraphs.join('\n').replace(/(\w)-\n(\w)/g, '$1$2').replace(/\n/g, ' ');
      return { title: c.title, text: tidy(text) };
    });
    return { title: book.title, author: book.author === 'Unknown' ? '' : book.author, language: 'en', chapters: chapters };
  }

  var TXT_HEADING = /^(?:chapter|part|book|prologue|epilogue|introduction|preface)\b[^\n]{0,80}$/im;

  async function fromTxt(file) {
    var raw = tidy((await file.text()).replace(/\r\n?/g, '\n'));
    var chapters = [], current = null;
    raw.split(/\n{2,}/).forEach(function (para) {
      var line = para.trim();
      if (TXT_HEADING.test(line) && line.indexOf('\n') === -1) {
        current = { title: line, parts: [] };
        chapters.push(current);
        return;
      }
      if (!current) { current = { title: 'Beginning', parts: [] }; chapters.push(current); }
      current.parts.push(line.replace(/\n/g, ' '));
    });
    return {
      title: file.name.replace(/\.[^.]+$/, ''),
      author: '',
      language: 'en',
      chapters: chapters.map(function (c) { return { title: c.title, text: c.parts.join('\n\n') }; })
    };
  }

  // -> {title, author, language, chapters: [{title, text, words}]}
  async function load(file, onProgress) {
    var name = file.name.toLowerCase();
    var book;
    if (name.endsWith('.epub')) book = await fromEpub(file);
    else if (name.endsWith('.pdf')) book = await fromPdf(file, onProgress);
    else if (name.endsWith('.txt') || name.endsWith('.md')) book = await fromTxt(file);
    else throw new Error('Use an EPUB, PDF, or TXT file.');

    book.chapters.forEach(function (c) { c.words = wordCount(c.text); });
    book.chapters = book.chapters.filter(function (c) { return c.words > 0; });
    if (!book.chapters.length) {
      throw new Error(name.endsWith('.pdf')
        ? 'No text found. This looks like a scanned PDF. Run it through Searchable PDF (OCR) first.'
        : 'No readable text found in this file.');
    }
    return book;
  }

  // ---------- sentence chunking -----------------------------------------------

  var segmenter = (typeof Intl !== 'undefined' && Intl.Segmenter)
    ? new Intl.Segmenter('en', { granularity: 'sentence' })
    : null;

  // Segmenters break after "Mr." or "J." as if a sentence ended there, which
  // puts an audible pause mid-name. Glue those pieces back on.
  var ABBREV = /(?:^|\s)(?:Mr|Mrs|Ms|Mx|Dr|Prof|Sr|Jr|St|Mt|Rev|Gen|Col|Capt|Lt|Sgt|Hon|vs|etc|approx|No|Vol|Ch|Fig|Inc|Ltd|Co|[A-Z]|e\.g|i\.e)\.$/;

  function rawSentences(para) {
    var parts = segmenter
      ? Array.from(segmenter.segment(para), function (s) { return s.segment.trim(); })
      : (para.match(/[^.!?…]+(?:[.!?…]+["'”’)]*|$)/g) || [para]).map(function (s) { return s.trim(); });
    var out = [];
    parts.filter(Boolean).forEach(function (s) {
      if (out.length && ABBREV.test(out[out.length - 1])) out[out.length - 1] += ' ' + s;
      else out.push(s);
    });
    return out;
  }

  // Split one over-long sentence at the last comma/semicolon/space before max.
  function hardSplit(s, max) {
    var out = [];
    while (s.length > max) {
      var cut = Math.max(s.lastIndexOf(', ', max), s.lastIndexOf('; ', max), s.lastIndexOf(' — ', max));
      if (cut < max * 0.4) cut = s.lastIndexOf(' ', max);
      if (cut <= 0) cut = max;
      out.push(s.slice(0, cut + 1).trim());
      s = s.slice(cut + 1).trim();
    }
    if (s) out.push(s);
    return out;
  }

  // Sentences for display/read-aloud: one entry per sentence, max length
  // enforced (speech engines choke on 1,000-character run-ons).
  function sentences(text, max) {
    max = max || 280;
    var out = [];
    text.split(/\n{2,}/).forEach(function (para) {
      rawSentences(para.replace(/\n/g, ' ')).forEach(function (s) {
        hardSplit(s, max).forEach(function (p) { out.push(p); });
      });
    });
    return out;
  }

  // Chunks for neural TTS: consecutive sentences merged up to `max` chars, so
  // each model call has enough context for natural intonation without
  // exceeding the model's input window.
  function chunks(text, max) {
    max = max || 300;
    var out = [], cur = '';
    sentences(text, max).forEach(function (s) {
      if (cur && cur.length + 1 + s.length > max) { out.push(cur); cur = s; }
      else cur = cur ? cur + ' ' + s : s;
    });
    if (cur) out.push(cur);
    return out;
  }

  // Stable key for resume state: same file + same choices = same job.
  function bookKey(file) {
    return [file.name, file.size, file.lastModified].join('|');
  }

  global.BookText = {
    load: load,
    sentences: sentences,
    chunks: chunks,
    wordCount: wordCount,
    bookKey: bookKey,
    htmlToText: htmlToText
  };
})(window);
