// Shared dropzone + UI helpers used by every converter page.
(function (global) {
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

  // ---------- lazy CDN loader -------------------------------------------------
  // Converter libraries are big (heic-to is 595 KB over the wire) and are only
  // needed once the user actually converts. Pages name what they need and the
  // module fetches it on first use, so a visitor who reads and leaves pays for
  // none of it. Mirrors the loader in universal-entry.js.

  var LIB = {
    jszip: {
      url: 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js',
      sri: 'sha384-+mbV2IY1Zk/X1p/nWllGySJSUN8uMs+gUAN10Or95UBH0fpj6GfKgPmgC5EXieXG',
      test: function () { return !!global.JSZip; }
    },
    pdflib: {
      url: 'https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js',
      sri: 'sha384-weMABwrltA6jWR8DDe9Jp5blk+tZQh7ugpCsF3JwSA53WZM9/14PjS5LAJNHNjAI',
      test: function () { return !!global.PDFLib; }
    },
    heicto: {
      url: 'https://cdn.jsdelivr.net/npm/heic-to@1.4.2/dist/iife/heic-to.js',
      sri: 'sha384-+TuTeQmUT7gbjDeK1kc34Ku+i44JqHZ6S/cgqVKf4gLclXpJJOrx9T6gxzDeTln5',
      test: function () { return !!(global.HeicTo || global.heicTo); }
    },
    tesseract: {
      url: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js',
      sri: 'sha384-GJqSu7vueQ9qN0E9yLPb3Wtpd7OrgK8KmYzC8T1IysG1bcvxvIO4qtYR/D3A991F',
      test: function () { return !!global.Tesseract; }
    }
  };

  var PDFJS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.min.mjs';
  var PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.worker.min.mjs';

  var pending = Object.create(null);   // key -> Promise<void>

  function loadOne(key) {
    if (pending[key]) return pending[key];

    if (key === 'pdfjs') {
      pending[key] = (async function () {
        if (global.pdfjsLib) return;
        var mod = await import(PDFJS_URL);
        // A Worker cannot be constructed from a cross-origin URL, so pointing
        // workerSrc straight at the CDN throws a SecurityError and rendering
        // stalls forever. Fetch the worker and hand pdf.js a same-origin
        // blob: URL instead (permitted by our worker-src 'self' blob:).
        try {
          var src = await (await fetch(PDFJS_WORKER)).text();
          mod.GlobalWorkerOptions.workerSrc =
            URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
        } catch (e) {
          mod.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
        }
        global.pdfjsLib = mod;
      })();
      return pending[key];
    }

    var lib = LIB[key];
    if (!lib) return Promise.reject(new Error('Unknown library: ' + key));
    if (lib.test()) { pending[key] = Promise.resolve(); return pending[key]; }

    pending[key] = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = lib.url;
      s.integrity = lib.sri;
      s.crossOrigin = 'anonymous';
      s.onload = function () { resolve(); };
      s.onerror = function () {
        delete pending[key];          // let a retry re-attempt the fetch
        reject(new Error('Could not load a required library (' + key + '). Check your connection or any content blocker, then try again.'));
      };
      document.head.appendChild(s);
    });
    return pending[key];
  }

  // CV.load('jszip', 'pdflib') -> Promise, resolves when all are on window.
  function load() {
    return Promise.all(Array.prototype.map.call(arguments, loadOne)).then(function () {});
  }

  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(2) + ' MB';
  }

  function bindDropzone(dropzoneEl, fileInputEl, onFiles, accept) {
    // Keyboard + screen-reader access. The dropzone is a div, so it needs the
    // button semantics spelled out or it is unreachable without a mouse.
    if (!dropzoneEl.hasAttribute('tabindex')) dropzoneEl.setAttribute('tabindex', '0');
    if (!dropzoneEl.hasAttribute('role')) dropzoneEl.setAttribute('role', 'button');
    if (!dropzoneEl.hasAttribute('aria-label')) {
      dropzoneEl.setAttribute('aria-label', 'Choose files to convert');
    }
    dropzoneEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        fileInputEl.click();
      }
    });

    dropzoneEl.addEventListener('click', function () { fileInputEl.click(); });
    fileInputEl.addEventListener('change', function (e) {
      var picked = Array.from(e.target.files);
      if (picked.length) {
        track('file_selected', { count: picked.length, in_ext: extOf(picked[0].name), method: 'browse' });
      }
      onFiles(picked);
      fileInputEl.value = '';
    });
    ['dragenter', 'dragover'].forEach(function (ev) {
      dropzoneEl.addEventListener(ev, function (e) {
        e.preventDefault();
        e.stopPropagation();
        dropzoneEl.classList.add('dragover');
      });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      dropzoneEl.addEventListener(ev, function (e) {
        e.preventDefault();
        e.stopPropagation();
        dropzoneEl.classList.remove('dragover');
      });
    });
    // Paste (Ctrl/Cmd+V) a screenshot or copied file anywhere on the page.
    // Skipped while typing in a field so normal text paste keeps working.
    document.addEventListener('paste', function (e) {
      var t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      var items = (e.clipboardData && e.clipboardData.files) ? Array.from(e.clipboardData.files) : [];
      if (!items.length) return;
      e.preventDefault();
      // Pasted screenshots arrive as "image.png"; give them a unique name.
      var stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      items = items.map(function (f, i) {
        if (!/^image\.(png|jpe?g|gif|webp)$/i.test(f.name)) return f;
        return new File([f], 'pasted-' + stamp + (items.length > 1 ? '-' + (i + 1) : '') + '.' + f.name.split('.').pop(), { type: f.type });
      });
      var accepted = accept ? items.filter(function (f) {
        return accept.some(function (ext) { return f.name.toLowerCase().endsWith(ext); });
      }) : items;
      track('file_selected', { count: accepted.length, rejected: items.length - accepted.length, in_ext: extOf((accepted[0] || {}).name), method: 'paste' });
      if (accepted.length) onFiles(accepted);
    });

    // "Choose a folder" for multi-file tools (a whole camera roll of HEICs, a
    // library folder of EPUBs). webkitdirectory works in all current browsers.
    if (fileInputEl.multiple && !dropzoneEl.querySelector('.folder-pick')) {
      var dirInput = document.createElement('input');
      dirInput.type = 'file';
      dirInput.hidden = true;
      dirInput.setAttribute('webkitdirectory', '');
      dirInput.multiple = true;
      var link = document.createElement('button');
      link.type = 'button';
      link.className = 'folder-pick';
      link.textContent = 'or choose a whole folder';
      link.addEventListener('click', function (e) { e.stopPropagation(); dirInput.click(); });
      dirInput.addEventListener('click', function (e) { e.stopPropagation(); });
      dirInput.addEventListener('change', function () {
        var all = Array.from(dirInput.files).filter(function (f) { return !/^\./.test(f.name); });
        var ok = accept ? all.filter(function (f) {
          return accept.some(function (ext) { return f.name.toLowerCase().endsWith(ext); });
        }) : all;
        ok.sort(function (a, b) { return (a.webkitRelativePath || a.name).localeCompare(b.webkitRelativePath || b.name, undefined, { numeric: true }); });
        track('file_selected', { count: ok.length, rejected: all.length - ok.length, in_ext: extOf((ok[0] || {}).name), method: 'folder' });
        onFiles(ok);
        dirInput.value = '';
      });
      dropzoneEl.appendChild(link);
      dropzoneEl.appendChild(dirInput);
    }

    dropzoneEl.addEventListener('drop', async function (e) {
      // Dropped folders arrive as directory entries; walk them for files.
      var entries = e.dataTransfer.items ? Array.from(e.dataTransfer.items)
        .map(function (it) { return it.webkitGetAsEntry && it.webkitGetAsEntry(); })
        .filter(Boolean) : [];
      var hasDir = entries.some(function (en) { return en.isDirectory; });
      var files = hasDir ? await filesFromEntries(entries) : Array.from(e.dataTransfer.files);
      var dropped = files.length;
      if (accept) {
        files = files.filter(function (f) {
          return accept.some(function (ext) {
            return f.name.toLowerCase().endsWith(ext);
          });
        });
      }
      if (dropped) {
        track('file_selected', {
          count: files.length,
          rejected: dropped - files.length,
          in_ext: extOf((files[0] || {}).name),
          method: 'drop'
        });
      }
      onFiles(files);
    });
  }

  // Recursively collect Files from dropped FileSystemEntries (folders).
  async function filesFromEntries(entries) {
    var out = [];
    async function walk(entry) {
      if (entry.isFile) {
        if (/^\./.test(entry.name)) return;          // .DS_Store and friends
        out.push(await new Promise(function (res, rej) { entry.file(res, rej); }));
      } else if (entry.isDirectory) {
        var reader = entry.createReader();
        for (;;) {                                   // readEntries returns batches
          var batch = await new Promise(function (res, rej) { reader.readEntries(res, rej); });
          if (!batch.length) break;
          for (var i = 0; i < batch.length; i++) await walk(batch[i]);
        }
      }
    }
    for (var i = 0; i < entries.length; i++) await walk(entries[i]);
    out.sort(function (a, b) { return a.name.localeCompare(b.name, undefined, { numeric: true }); });
    return out;
  }

  // ---------- batch conversion ----------------------------------------------
  // Pages convert one file at a time with their own code. runBatch calls that
  // code once per file; while it runs, setProgress/setStatus are scaled and
  // prefixed so each page's own progress messages read "File 2 of 5 · …".
  var batchCtx = null;

  async function runBatch(files, convertOne, opts) {
    var statusEl = opts.status;
    if (files.length <= 1) {
      var r = await convertOne(files[0]);
      downloadBlob(r.blob, r.filename);
      setStatus(statusEl, 'success', 'Done! Downloaded ' + r.filename);
      return { ok: 1, failed: [] };
    }
    await load('jszip');
    var zip = new JSZip(), ok = 0, failed = [], used = Object.create(null);
    for (var i = 0; i < files.length; i++) {
      batchCtx = { i: i, n: files.length, name: files[i].name, bar: opts.bar };
      try {
        var res = await convertOne(files[i]);
        var name = res.filename, k = 2;
        while (used[name]) name = res.filename.replace(/(\.[^.]+)?$/, ' (' + (k++) + ')$1');
        used[name] = true;
        zip.file(name, res.blob, { compression: 'STORE' });
        ok++;
      } catch (e) {
        console.error(files[i].name, e);
        track('conversion_error', { message: String(e && e.message || e).slice(0, 100), batch: true });
        failed.push(files[i].name + ' (' + friendlyError(String(e && e.message || e)) + ')');
      }
    }
    batchCtx = null;
    if (!ok) throw new Error(failed.length === 1 ? failed[0] : 'None of the ' + files.length + ' files could be converted. First problem: ' + failed[0]);
    if (opts.bar) setProgress(opts.bar, 100);
    setStatus(statusEl, 'info', 'Zipping ' + ok + ' files…');
    var blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
    downloadBlob(blob, toolName() + '-' + ok + '-files.zip');
    setStatus(statusEl, 'success', 'Done! Converted ' + ok + ' of ' + files.length + ' files into one zip.' +
      (failed.length ? ' Skipped: ' + failed.join('; ') : ''));
    track('batch_complete', { count: ok, rejected: failed.length });
    return { ok: ok, failed: failed };
  }

  function setStatus(el, kind, msg) {
    if (batchCtx && kind === 'info') {
      msg = 'File ' + (batchCtx.i + 1) + ' of ' + batchCtx.n + ' · ' + batchCtx.name + ': ' + msg;
    }
    // Progress text is the only feedback during a long OCR run, so announce it.
    if (!el.hasAttribute('role')) {
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
    }
    if (kind === 'error') track('conversion_error', { message: String(msg).slice(0, 100) });
    el.className = 'status ' + kind;
    el.textContent = kind === 'error' ? friendlyError(msg) : msg;
    if (kind === 'error') appendReportLink(el, msg);   // report keeps the raw text
  }

  // Library errors are written for developers ("Can't find end of central
  // directory"). Say what it means for the person holding the file.
  var FRIENDLY = [
    [/end of central directory|is this a zip file|Corrupted zip|invalid zip/i,
      'This file couldn’t be opened. It may be incomplete, DRM-protected, or a different format renamed with this extension.'],
    [/PasswordException|No password given|password/i,
      'This PDF is password-protected. Open it in your PDF reader, save a copy without the password, and try that.'],
    [/InvalidPDFException|Invalid PDF structure|Invalid XRef|Missing PDF/i,
      'This PDF couldn’t be read. It may be damaged or only partly downloaded.'],
    [/Array buffer allocation failed|out of memory|RangeError|Maximum call stack|QuotaExceeded/i,
      'Your device ran out of memory on this file. Try a smaller file, fewer files at once, or a laptop/desktop browser.'],
    [/Could not load a required library|Failed to fetch|NetworkError|Load failed|audio engine download/i,
      'Part of the converter couldn’t download. Check your connection or any ad/content blocker, then try again.'],
    [/libheif|heic|HEIF/i,
      'This HEIC photo couldn’t be decoded. Some Live Photos and edited images use variants the decoder can’t read yet.']
  ];
  function friendlyError(msg) {
    var raw = String(msg || '');
    var prefix = /^Failed:\s*/.test(raw) ? 'Failed: ' : '';
    for (var i = 0; i < FRIENDLY.length; i++) {
      if (FRIENDLY[i][0].test(raw)) return prefix + FRIENDLY[i][1];
    }
    return raw;
  }

  // Every error gets a one-click way to tell us. It opens a pre-filled GitHub
  // issue; nothing is sent until the user reviews it and submits there.
  var REPO = 'https://github.com/andrewnakas/freebookconvert';
  function reportUrl(msg) {
    var err = String(msg || '').replace(/^Failed:\s*/, '').slice(0, 200);
    var q = {
      template: 'bug.yml',
      title: toolName() + ': ' + err.slice(0, 70),
      tool: toolName(),
      error: err,
      browser: navigator.userAgent.slice(0, 200)
    };
    return REPO + '/issues/new?' + Object.keys(q).map(function (k) {
      return k + '=' + encodeURIComponent(q[k]);
    }).join('&');
  }
  function appendReportLink(el, msg) {
    var a = document.createElement('a');
    a.href = reportUrl(msg);
    a.target = '_blank';
    a.rel = 'noopener';
    a.className = 'report-link';
    a.textContent = 'Report this problem';
    a.addEventListener('click', function () { track('report_problem', {}); });
    el.appendChild(document.createTextNode(' '));
    el.appendChild(a);
  }

  function clearStatus(el) {
    el.className = 'status hidden';
    el.textContent = '';
  }

  function setProgress(barEl, pct) {
    var v = Math.max(0, Math.min(100, pct));
    // During a batch, one file's 0-100 is a slice of the whole bar.
    if (batchCtx && barEl === batchCtx.bar) v = (batchCtx.i + v / 100) / batchCtx.n * 100;
    barEl.style.width = v + '%';
    var wrap = barEl.parentElement;
    if (wrap) {
      if (!wrap.hasAttribute('role')) {
        wrap.setAttribute('role', 'progressbar');
        wrap.setAttribute('aria-valuemin', '0');
        wrap.setAttribute('aria-valuemax', '100');
      }
      wrap.setAttribute('aria-valuenow', Math.round(v));
    }
  }

  // ---------- analytics ------------------------------------------------------
  // GA4 recorded pageviews only, so there was no way to tell which tools people
  // actually finish using. Route everything through one helper and hook it into
  // the calls every converter page already makes.

  function toolName() {
    var p = location.pathname.replace(/\.html$/, '').replace(/\/$/, '');
    return p === '' ? 'home' : p.split('/').pop();
  }

  function track(event, params) {
    if (typeof window.gtag !== 'function') return;
    var payload = { tool: toolName() };
    for (var k in params) if (Object.prototype.hasOwnProperty.call(params, k)) payload[k] = params[k];
    try { window.gtag('event', event, payload); } catch (e) { /* never break a conversion */ }
  }

  function extOf(name) {
    var m = /\.([a-z0-9]+)$/i.exec(name || '');
    return m ? m[1].toLowerCase() : 'none';
  }

  // ---------- retention: "what next" + recently used tools --------------------
  // A finished conversion is the moment a visitor is most likely to do a second
  // thing, and before this they just left. Suggest the natural follow-up for the
  // file they now hold, and remember which tools they use so the homepage can
  // put those first on the next visit.

  var TOOLS = {
    'merge-pdf':          ['Merge PDFs', 'Combine this with other PDFs into one file.'],
    'searchable-pdf':     ['Make it searchable', 'Add an invisible OCR text layer to a scanned PDF.'],
    'pdf-to-epub':        ['PDF to EPUB', 'Reflow it into an ebook for your phone or e-reader.'],
    'pdf-to-jpg':         ['PDF to JPG', 'Pull every page out as an image.'],
    'epub-to-pdf':        ['EPUB to PDF', 'Fixed pages for printing or forms.'],
    'epub-to-txt':        ['EPUB to TXT', 'Plain text for scripts, notes, or AI tools.'],
    'images-to-pdf':      ['Images to PDF', 'Bundle these images into a single PDF.'],
    'image-to-text':      ['Image to text', 'Copy the words out of a photo or screenshot.'],
    'cbz-to-pdf':         ['CBZ to PDF', 'Turn a comic archive into a PDF.'],
    'jpg-to-cbz':         ['Images to CBZ', 'Pack images into a comic archive for a reader app.'],
    'epub-to-audiobook':  ['Make it an audiobook', 'Narrate it with a natural AI voice, saved as MP3.'],
    'read-aloud':         ['Read it aloud now', 'Listen instantly with your browser\u2019s voices.'],
    'mp3-to-m4b':         ['MP3s to M4B', 'Join MP3s into one audiobook with chapters.'],
    'm4b-to-mp3':         ['M4B to MP3', 'Split an audiobook into one MP3 per chapter.']
  };
  var GUIDES = {
    sideload: ['/guides/sideload-ebooks-to-ereader', 'Put it on your e-reader', 'Kindle, Kobo, Boox, reMarkable: step by step.'],
    m4b: ['/guides/what-is-m4b', 'Where M4B files play', 'Apple Books, BookPlayer, Plex, and how chapters work.']
  };
  // Output extension -> follow-ups, best first. The current page is skipped.
  var NEXT = {
    pdf:  ['merge-pdf', 'searchable-pdf', 'pdf-to-epub', 'sideload'],
    epub: ['epub-to-audiobook', 'sideload', 'epub-to-pdf'],
    txt:  ['read-aloud', 'epub-to-audiobook'],
    m4b:  ['m4b', 'm4b-to-mp3'],
    mp3:  ['mp3-to-m4b', 'm4b'],
    jpg:  ['images-to-pdf', 'image-to-text', 'jpg-to-cbz'],
    png:  ['images-to-pdf', 'image-to-text'],
    webp: ['images-to-pdf', 'image-to-text'],
    zip:  ['images-to-pdf', 'jpg-to-cbz'],
    cbz:  ['cbz-to-pdf', 'sideload']
  };

  // Where the output extension is ambiguous (a .zip of MP3s is not a .zip of
  // images), the tool decides.
  var NEXT_BY_TOOL = {
    'm4b-to-mp3':        ['mp3-to-m4b', 'epub-to-audiobook'],
    'epub-to-audiobook': ['m4b', 'm4b-to-mp3', 'read-aloud'],
    'pdf-to-audiobook':  ['m4b', 'm4b-to-mp3', 'read-aloud']
  };

  function suggestionsFor(outExt) {
    var here = toolName();
    return (NEXT_BY_TOOL[here] || NEXT[outExt] || []).filter(function (k) { return k !== here; }).slice(0, 3).map(function (k) {
      if (GUIDES[k]) return { key: k, href: GUIDES[k][0], title: GUIDES[k][1], text: GUIDES[k][2] };
      return { key: k, href: '/pages/' + k, title: TOOLS[k][0], text: TOOLS[k][1] };
    });
  }

  // Renders below `anchor` (default: the page's converter box). Replaces any
  // earlier panel so a batch of downloads shows one panel, not five.
  function showNextSteps(outExt, anchor) {
    anchor = anchor || $('.converter-app');
    if (!anchor || !anchor.parentNode) return;
    var items = suggestionsFor(outExt);
    var old = $('#nextSteps');
    if (old) old.remove();
    if (!items.length) return;
    var sec = document.createElement('section');
    sec.id = 'nextSteps';
    sec.className = 'next-steps';
    sec.setAttribute('aria-label', 'What to do next');
    sec.innerHTML = '<h2>What next?</h2><div class="card-grid"></div>';
    var grid = sec.querySelector('.card-grid');
    items.forEach(function (it) {
      var a = document.createElement('a');
      a.className = 'card';
      a.href = it.href;
      a.innerHTML = '<h3></h3><p></p>';
      a.querySelector('h3').textContent = it.title;
      a.querySelector('p').textContent = it.text;
      a.addEventListener('click', function () { track('next_step_click', { target: it.key, out_ext: outExt }); });
      grid.appendChild(a);
    });
    anchor.parentNode.insertBefore(sec, anchor.nextSibling);
  }

  var RECENT_KEY = 'fbc_recent';

  function readRecent() {
    try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; } catch (e) { return []; }
  }

  function rememberTool() {
    if (!/^\/pages\//.test(location.pathname)) return;
    var slug = toolName();
    var h1 = $('h1');
    var title = (h1 && h1.textContent.trim()) || slug;
    var list = readRecent().filter(function (r) { return r.slug !== slug; });
    list.unshift({ slug: slug, title: title.slice(0, 60), t: Date.now() });
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 5))); } catch (e) { /* private mode */ }
  }

  // Homepage: fill <section id="recentTools" hidden> for returning visitors.
  function renderRecentTools(el) {
    var list = readRecent();
    if (!el || !list.length) return;
    el.innerHTML = '<h2>Your tools</h2><div class="recent-tools"></div>';
    var row = el.querySelector('.recent-tools');
    list.forEach(function (r) {
      var a = document.createElement('a');
      a.className = 'recent-tool';
      a.href = '/pages/' + encodeURIComponent(r.slug);
      a.textContent = r.title;
      a.addEventListener('click', function () { track('return_visit_tool', { target: r.slug }); });
      row.appendChild(a);
    });
    el.hidden = false;
  }

  function downloadBlob(blob, filename) {
    // Every page funnels a finished conversion through here.
    track('conversion_complete', {
      out_ext: extOf(filename),
      out_bytes: blob && blob.size || 0
    });
    rememberTool();
    showNextSteps(extOf(filename));
    try { document.dispatchEvent(new CustomEvent('fbc:converted', { detail: { out_ext: extOf(filename) } })); } catch (e) {}
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function renderFileList(listEl, files, onRemove) {
    listEl.innerHTML = '';
    files.forEach(function (f, idx) {
      var item = document.createElement('div');
      item.className = 'file-item';
      item.innerHTML = '<span><span class="name"></span><span class="size"></span></span>';
      item.querySelector('.name').textContent = f.name;
      item.querySelector('.size').textContent = fmtBytes(f.size);
      var rm = document.createElement('button');
      rm.className = 'remove';
      rm.textContent = '×';
      rm.title = 'Remove';
      rm.onclick = function () { onRemove(idx); };
      item.appendChild(rm);
      listEl.appendChild(item);
    });
  }

  // Every converter page uses #convertBtn, so one delegated listener measures
  // the select -> convert drop-off across all of them without per-page edits.
  document.addEventListener('click', function (e) {
    var btn = e.target && e.target.closest && e.target.closest('#convertBtn');
    if (btn && !btn.disabled) track('conversion_start', {});
  }, true);

  global.CV = {
    $: $, $$: $$,
    load: load,
    track: track,
    fmtBytes: fmtBytes,
    bindDropzone: bindDropzone,
    setStatus: setStatus,
    clearStatus: clearStatus,
    setProgress: setProgress,
    downloadBlob: downloadBlob,
    renderFileList: renderFileList,
    showNextSteps: showNextSteps,
    reportUrl: reportUrl,
    appendReportLink: appendReportLink,
    friendlyError: friendlyError,
    runBatch: runBatch,
    renderRecentTools: renderRecentTools
  };
})(window);
