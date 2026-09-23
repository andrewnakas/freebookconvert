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
    dropzoneEl.addEventListener('drop', function (e) {
      var files = Array.from(e.dataTransfer.files);
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

  function setStatus(el, kind, msg) {
    // Progress text is the only feedback during a long OCR run, so announce it.
    if (!el.hasAttribute('role')) {
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
    }
    if (kind === 'error') track('conversion_error', { message: String(msg).slice(0, 100) });
    el.className = 'status ' + kind;
    el.textContent = msg;
  }

  function clearStatus(el) {
    el.className = 'status hidden';
    el.textContent = '';
  }

  function setProgress(barEl, pct) {
    var v = Math.max(0, Math.min(100, pct));
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

  function downloadBlob(blob, filename) {
    // Every page funnels a finished conversion through here.
    track('conversion_complete', {
      out_ext: extOf(filename),
      out_bytes: blob && blob.size || 0
    });
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
    renderFileList: renderFileList
  };
})(window);
