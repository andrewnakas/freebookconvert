/*
 * Universal converter entry: drop a file, pick a target format, convert in place.
 *
 * The widget runs every conversion locally on the homepage. CDN scripts and
 * converter modules are loaded lazily on first use, then cached.
 */
(function (global) {
  // ---------- lazy-loader -----------------------------------------------------

  var loaded = Object.create(null);          // url -> Promise<void>
  var SRI = {
    'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js':
      'sha384-+mbV2IY1Zk/X1p/nWllGySJSUN8uMs+gUAN10Or95UBH0fpj6GfKgPmgC5EXieXG',
    'https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js':
      'sha384-weMABwrltA6jWR8DDe9Jp5blk+tZQh7ugpCsF3JwSA53WZM9/14PjS5LAJNHNjAI',
    'https://cdn.jsdelivr.net/npm/heic-to@1.4.2/dist/iife/heic-to.js':
      'sha384-+TuTeQmUT7gbjDeK1kc34Ku+i44JqHZ6S/cgqVKf4gLclXpJJOrx9T6gxzDeTln5'
  };

  function loadScript(url) {
    if (loaded[url]) return loaded[url];
    loaded[url] = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = url;
      if (SRI[url]) { s.integrity = SRI[url]; s.crossOrigin = 'anonymous'; }
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('Failed to load ' + url)); };
      document.head.appendChild(s);
    });
    return loaded[url];
  }

  // pdf.js is an ES module; load it once and stash on window.pdfjsLib.
  function loadPdfJs() {
    var KEY = 'pdfjs-esm';
    if (loaded[KEY]) return loaded[KEY];
    loaded[KEY] = (async function () {
      var mod = await import('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.min.mjs');
      mod.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.worker.min.mjs';
      global.pdfjsLib = mod;
    })();
    return loaded[KEY];
  }

  function loadJsZip()  { return loadScript('https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js'); }
  function loadPdfLib() { return loadScript('https://unpkg.com/pdf-lib@1.17.1/dist/pdf-lib.min.js'); }
  function loadHeicTo() { return loadScript('https://cdn.jsdelivr.net/npm/heic-to@1.4.2/dist/iife/heic-to.js'); }

  // Local converter modules already live in /js/. Load on demand.
  function loadModule(path) { return loadScript(path); }

  // ---------- runners ---------------------------------------------------------
  // Each runner takes (file, onProgress) and returns { blob, filename }.

  async function runEpubToPdf(file, onProgress) {
    await Promise.all([loadJsZip(), loadPdfLib(), loadModule('/js/epub-parser.js'), loadModule('/js/epub-to-pdf.js')]);
    var blob = await global.EpubToPdf.convert(file, onProgress);
    return { blob: blob, filename: file.name.replace(/\.epub$/i, '') + '.pdf' };
  }
  async function runEpubToTxt(file, onProgress) {
    await Promise.all([loadJsZip(), loadModule('/js/epub-parser.js'), loadModule('/js/epub-to-txt.js')]);
    var blob = await global.EpubToTxt.convert(file, onProgress);
    return { blob: blob, filename: file.name.replace(/\.epub$/i, '') + '.txt' };
  }
  async function runPdfToEpub(file, onProgress) {
    await Promise.all([loadJsZip(), loadPdfJs(), loadModule('/js/pdf-to-epub.js')]);
    var blob = await global.PdfToEpub.convert(file, { pagesPerChapter: 0 }, onProgress);
    return { blob: blob, filename: file.name.replace(/\.pdf$/i, '') + '.epub' };
  }
  function runPdfToImage(format) {
    return async function (file, onProgress) {
      await Promise.all([loadJsZip(), loadPdfJs(), loadModule('/js/pdf-to-images.js')]);
      var r = await global.PdfToImages.convert(file, { format: format, scale: 2, quality: 0.92 }, onProgress);
      return { blob: r.blob, filename: r.filename };
    };
  }
  async function runCbzToPdf(file, onProgress) {
    await Promise.all([loadJsZip(), loadPdfLib(), loadModule('/js/cbz-to-pdf.js')]);
    var blob = await global.CbzToPdf.convert(file, {}, onProgress);
    return { blob: blob, filename: file.name.replace(/\.(cbz|zip)$/i, '') + '.pdf' };
  }
  async function runHeicToPdf(file, onProgress) {
    await Promise.all([loadPdfLib(), loadHeicTo(), loadModule('/js/heic-to-pdf.js')]);
    var blob = await global.HeicToPdf.convert([file], { quality: 0.92 }, onProgress);
    return { blob: blob, filename: file.name.replace(/\.(heic|heif)$/i, '') + '.pdf' };
  }
  function runImageTo(targetExt) {
    return async function (file, onProgress) {
      var deps = [loadJsZip(), loadModule('/js/image-convert.js')];
      if (/\.(heic|heif)$/i.test(file.name)) deps.push(loadHeicTo());
      await Promise.all(deps);
      onProgress && onProgress(20, 'Decoding\u2026');
      var blob = await global.ImageConvert.convertOne(file, targetExt, { quality: 0.95 });
      onProgress && onProgress(100, 'Done');
      return { blob: blob, filename: file.name.replace(/\.[^.]+$/, '') + '.' + targetExt };
    };
  }
  async function runImageToPdf(file, onProgress) {
    // Single-image -> PDF via heic-to-pdf.js (works for jpg/png/webp too).
    await Promise.all([loadPdfLib(), loadModule('/js/heic-to-pdf.js')]);
    var blob = await global.HeicToPdf.convert([file], { quality: 0.92 }, onProgress);
    return { blob: blob, filename: file.name.replace(/\.[^.]+$/, '') + '.pdf' };
  }

  // ---------- routes ----------------------------------------------------------

  var ROUTES = {
    epub: [
      { label: 'PDF',                 run: runEpubToPdf },
      { label: 'TXT (plain text)',    run: runEpubToTxt }
    ],
    pdf: [
      { label: 'EPUB (ebook)',        run: runPdfToEpub },
      { label: 'JPG (page images)',   run: runPdfToImage('jpg') },
      { label: 'PNG (page images)',   run: runPdfToImage('png') }
    ],
    cbz: [{ label: 'PDF',             run: runCbzToPdf }],
    zip: [{ label: 'PDF (as comic archive)', run: runCbzToPdf }],
    heic: [
      { label: 'PDF',                 run: runHeicToPdf },
      { label: 'JPG',                 run: runImageTo('jpg') },
      { label: 'PNG',                 run: runImageTo('png') }
    ],
    jpg: [
      { label: 'PNG',                 run: runImageTo('png') },
      { label: 'WEBP',                run: runImageTo('webp') },
      { label: 'PDF',                 run: runImageToPdf }
    ],
    png: [
      { label: 'JPG',                 run: runImageTo('jpg') },
      { label: 'WEBP',                run: runImageTo('webp') },
      { label: 'PDF',                 run: runImageToPdf }
    ],
    webp: [
      { label: 'JPG',                 run: runImageTo('jpg') },
      { label: 'PNG',                 run: runImageTo('png') },
      { label: 'PDF',                 run: runImageToPdf }
    ]
  };
  ROUTES.jpeg = ROUTES.jpg;
  ROUTES.heif = ROUTES.heic;

  // ---------- helpers ---------------------------------------------------------

  function extOf(name) {
    var m = name.toLowerCase().match(/\.([a-z0-9]+)$/);
    return m ? m[1] : '';
  }
  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(2) + ' MB';
  }
  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  // ---------- UI --------------------------------------------------------------

  function init(container) {
    container.innerHTML =
      '<div class="universal-entry">' +
        '<div class="dropzone" id="uniDrop">' +
          '<p class="big">Drop any supported file here</p>' +
          '<p>or <strong>click to browse</strong></p>' +
          '<p style="font-size:0.85rem">EPUB &middot; PDF &middot; CBZ &middot; HEIC &middot; JPG &middot; PNG &middot; WEBP</p>' +
          '<input type="file" id="uniInput">' +
        '</div>' +
        '<div id="uniPicker" class="universal-picker" hidden>' +
          '<div class="uni-file"><span class="uni-name"></span> <span class="uni-size"></span> <button type="button" class="remove" id="uniClear" title="Remove">&times;</button></div>' +
          '<label class="uni-target">Convert to: <select id="uniTarget"></select></label>' +
          '<button class="btn" id="uniGo">Convert</button>' +
        '</div>' +
        '<div class="progress" id="uniProgressWrap" style="display:none"><div class="progress-bar" id="uniProgress"></div></div>' +
        '<div id="uniStatus" class="status hidden"></div>' +
      '</div>';

    var dz       = container.querySelector('#uniDrop');
    var input    = container.querySelector('#uniInput');
    var picker   = container.querySelector('#uniPicker');
    var nameEl   = container.querySelector('.uni-name');
    var sizeEl   = container.querySelector('.uni-size');
    var targetEl = container.querySelector('#uniTarget');
    var clearBtn = container.querySelector('#uniClear');
    var goBtn    = container.querySelector('#uniGo');
    var progWrap = container.querySelector('#uniProgressWrap');
    var progBar  = container.querySelector('#uniProgress');
    var statusEl = container.querySelector('#uniStatus');

    var current = null;
    var done = false;  // true after a successful conversion; next click resets

    function setStatus(kind, msg) {
      statusEl.className = 'status ' + kind;
      statusEl.textContent = msg;
    }
    function clearStatus() {
      statusEl.className = 'status hidden';
      statusEl.textContent = '';
    }
    function setProgress(pct) {
      progBar.style.width = Math.max(0, Math.min(100, pct)) + '%';
    }
    function reset() {
      current = null;
      done = false;
      picker.hidden = true;
      dz.style.display = '';
      input.value = '';
      progWrap.style.display = 'none';
      setProgress(0);
      clearStatus();
      goBtn.disabled = false;
      goBtn.textContent = 'Convert';
    }

    function accept(file) {
      clearStatus();
      var ext = extOf(file.name);
      var routes = ROUTES[ext];
      if (!routes) {
        setStatus('error', 'Sorry, .' + (ext || 'this file') + ' isn\u2019t supported yet. Try EPUB, PDF, CBZ, HEIC, JPG, PNG, or WEBP.');
        return;
      }
      current = { file: file, routes: routes };
      nameEl.textContent = file.name;
      sizeEl.textContent = '(' + fmtBytes(file.size) + ')';
      targetEl.innerHTML = '';
      routes.forEach(function (r, i) {
        var opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = r.label;
        targetEl.appendChild(opt);
      });
      dz.style.display = 'none';
      picker.hidden = false;
    }

    dz.addEventListener('click', function () { input.click(); });
    input.addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      if (f) accept(f);
    });
    ['dragenter', 'dragover'].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('dragover'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove('dragover'); });
    });
    dz.addEventListener('drop', function (e) {
      var f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) accept(f);
    });

    clearBtn.addEventListener('click', reset);

    goBtn.addEventListener('click', async function () {
      if (done) { reset(); return; }
      if (!current) return;
      var route = current.routes[parseInt(targetEl.value, 10) || 0];
      goBtn.disabled = true;
      goBtn.textContent = 'Converting\u2026';
      progWrap.style.display = 'block';
      setProgress(2);
      setStatus('info', 'Loading converter\u2026');
      try {
        var result = await route.run(current.file, function (p, m) {
          setProgress(p);
          if (m) setStatus('info', m);
        });
        downloadBlob(result.blob, result.filename);
        setStatus('success', 'Done! Downloaded ' + result.filename);
        goBtn.textContent = 'Convert another';
        goBtn.disabled = false;
        done = true;
      } catch (e) {
        console.error(e);
        setStatus('error', 'Failed: ' + (e && e.message ? e.message : String(e)));
        goBtn.disabled = false;
        goBtn.textContent = 'Convert';
      }
    });
  }

  global.UniversalEntry = { init: init };
})(window);
