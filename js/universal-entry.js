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
  function loadTesseract() { return loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js'); }

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
  async function runPdfOcrText(file, onProgress) {
    await Promise.all([loadPdfJs(), loadTesseract(), loadModule('/js/pdf-ocr.js?v=ocr1')]);
    var r = await global.PdfOcr.convert(file, { format: 'txt', scale: 2 }, onProgress);
    return { blob: r.blob, filename: r.filename };
  }
  async function runPdfOcrPdf(file, onProgress) {
    await Promise.all([loadPdfJs(), loadPdfLib(), loadTesseract(), loadModule('/js/pdf-ocr.js?v=ocr1')]);
    var r = await global.PdfOcr.convert(file, { format: 'pdf', scale: 2 }, onProgress);
    return { blob: r.blob, filename: r.filename };
  }

  // ---------- combined runners (multi-file) -----------------------------------

  async function runImagesToCombinedPdf(files, onProgress) {
    await Promise.all([loadPdfLib(), loadHeicTo(), loadModule('/js/heic-to-pdf.js')]);
    var blob = await global.HeicToPdf.convert(files, { quality: 0.92 }, onProgress);
    return { blob: blob, filename: 'combined.pdf' };
  }
  async function runImagesToSearchablePdf(files, onProgress) {
    await Promise.all([loadPdfJs(), loadPdfLib(), loadHeicTo(), loadTesseract(),
                       loadModule('/js/heic-to-pdf.js'), loadModule('/js/pdf-ocr.js?v=ocr1')]);
    onProgress && onProgress(2, 'Bundling into a PDF\u2026');
    var pdfBlob = await global.HeicToPdf.convert(files, { quality: 0.92 }, function (p, m) {
      onProgress && onProgress(Math.min(35, 2 + p * 0.33), m || 'Bundling\u2026');
    });
    var pseudo = new File([pdfBlob], 'combined.pdf', { type: 'application/pdf' });
    var r = await global.PdfOcr.convert(pseudo, { format: 'pdf', scale: 2 }, function (p, m) {
      onProgress && onProgress(35 + p * 0.65, m || 'OCR\u2026');
    });
    return { blob: r.blob, filename: 'combined-searchable.pdf' };
  }
  async function mergePdfs(files, onProgress) {
    await loadPdfLib();
    onProgress && onProgress(2, 'Merging PDFs\u2026');
    var merged = await PDFLib.PDFDocument.create();
    for (var i = 0; i < files.length; i++) {
      onProgress && onProgress(2 + Math.floor(90 * (i / files.length)), 'Merging ' + (i + 1) + '/' + files.length);
      var bytes = new Uint8Array(await files[i].arrayBuffer());
      var src = await PDFLib.PDFDocument.load(bytes);
      var pages = await merged.copyPages(src, src.getPageIndices());
      pages.forEach(function (p) { merged.addPage(p); });
    }
    var out = await merged.save();
    return new Blob([out], { type: 'application/pdf' });
  }
  async function runPdfsToCombinedPdf(files, onProgress) {
    var blob = await mergePdfs(files, onProgress);
    onProgress && onProgress(100, 'Done');
    return { blob: blob, filename: 'combined.pdf' };
  }
  async function runPdfsToCombinedSearchablePdf(files, onProgress) {
    await Promise.all([loadPdfJs(), loadPdfLib(), loadTesseract(), loadModule('/js/pdf-ocr.js?v=ocr1')]);
    var mergedBlob = await mergePdfs(files, function (p, m) {
      onProgress && onProgress(Math.min(30, p * 0.3), m || 'Merging\u2026');
    });
    var pseudo = new File([mergedBlob], 'combined.pdf', { type: 'application/pdf' });
    var r = await global.PdfOcr.convert(pseudo, { format: 'pdf', scale: 2 }, function (p, m) {
      onProgress && onProgress(30 + p * 0.70, m || 'OCR\u2026');
    });
    return { blob: r.blob, filename: 'combined-searchable.pdf' };
  }
  async function runPdfsToCombinedText(files, onProgress) {
    await Promise.all([loadPdfJs(), loadTesseract(), loadModule('/js/pdf-ocr.js?v=ocr1')]);
    var parts = [];
    for (var i = 0; i < files.length; i++) {
      var idx = i;
      var r = await global.PdfOcr.convert(files[i], { format: 'txt', scale: 2 }, function (p, m) {
        var overall = (idx + p / 100) / files.length * 100;
        onProgress && onProgress(overall, '[' + (idx + 1) + '/' + files.length + '] ' + (m || 'OCR\u2026'));
      });
      parts.push('===== ' + files[i].name + ' =====\n');
      parts.push(await r.blob.text());
      parts.push('\n\n');
    }
    return { blob: new Blob(parts, { type: 'text/plain' }), filename: 'combined.txt' };
  }

  // ---------- batch wrapper: run per-file route, ZIP the outputs --------------

  function runEachZipped(perFileRoute) {
    return async function (files, onProgress) {
      await loadJsZip();
      var zip = new JSZip();
      for (var i = 0; i < files.length; i++) {
        var idx = i;
        var r = await perFileRoute(files[i], function (p, m) {
          var overall = (idx + p / 100) / files.length * 100;
          onProgress && onProgress(overall, '[' + (idx + 1) + '/' + files.length + '] ' + (m || 'Working\u2026'));
        });
        zip.file(r.filename, r.blob);
      }
      onProgress && onProgress(98, 'Packing ZIP\u2026');
      var blob = await zip.generateAsync({ type: 'blob' });
      return { blob: blob, filename: 'converted.zip' };
    };
  }

  // ---------- routes ----------------------------------------------------------
  // Each route: { label, run(fileOrFiles, onProgress), multi? }
  // multi: 'each' (one input -> one output, ZIP if multiple)
  //        'combined' (many inputs -> one output)
  //        'single' (only available when one file is dropped)

  var ROUTES = {
    epub: [
      { label: 'PDF',                       run: runEpubToPdf,    multi: 'each' },
      { label: 'TXT (plain text)',          run: runEpubToTxt,    multi: 'each' }
    ],
    pdf: [
      { label: 'EPUB (ebook)',              run: runPdfToEpub,    multi: 'each' },
      { label: 'JPG (page images)',         run: runPdfToImage('jpg'), multi: 'each' },
      { label: 'PNG (page images)',         run: runPdfToImage('png'), multi: 'each' },
      { label: 'TXT via OCR (scanned PDF)', run: runPdfOcrText,   multi: 'each' },
      { label: 'Searchable PDF via OCR',    run: runPdfOcrPdf,    multi: 'each' },
      { label: 'Combined PDF (merge)',           run: runPdfsToCombinedPdf,           multi: 'combined' },
      { label: 'Combined Searchable PDF (OCR)',  run: runPdfsToCombinedSearchablePdf, multi: 'combined' },
      { label: 'Combined OCR text (.txt)',       run: runPdfsToCombinedText,          multi: 'combined' }
    ],
    cbz: [{ label: 'PDF',                   run: runCbzToPdf,     multi: 'each' }],
    zip: [{ label: 'PDF (as comic archive)', run: runCbzToPdf,    multi: 'each' }],
    heic: [
      { label: 'PDF',                       run: runHeicToPdf,    multi: 'each' },
      { label: 'JPG',                       run: runImageTo('jpg'), multi: 'each' },
      { label: 'PNG',                       run: runImageTo('png'), multi: 'each' },
      { label: 'Combined PDF',              run: runImagesToCombinedPdf,        multi: 'combined' },
      { label: 'Combined Searchable PDF',   run: runImagesToSearchablePdf,      multi: 'combined' }
    ],
    jpg: [
      { label: 'PNG',                       run: runImageTo('png'), multi: 'each' },
      { label: 'WEBP',                      run: runImageTo('webp'), multi: 'each' },
      { label: 'PDF',                       run: runImageToPdf,   multi: 'each' },
      { label: 'Combined PDF',              run: runImagesToCombinedPdf,        multi: 'combined' },
      { label: 'Combined Searchable PDF',   run: runImagesToSearchablePdf,      multi: 'combined' }
    ],
    png: [
      { label: 'JPG',                       run: runImageTo('jpg'), multi: 'each' },
      { label: 'WEBP',                      run: runImageTo('webp'), multi: 'each' },
      { label: 'PDF',                       run: runImageToPdf,   multi: 'each' },
      { label: 'Combined PDF',              run: runImagesToCombinedPdf,        multi: 'combined' },
      { label: 'Combined Searchable PDF',   run: runImagesToSearchablePdf,      multi: 'combined' }
    ],
    webp: [
      { label: 'JPG',                       run: runImageTo('jpg'), multi: 'each' },
      { label: 'PNG',                       run: runImageTo('png'), multi: 'each' },
      { label: 'PDF',                       run: runImageToPdf,   multi: 'each' },
      { label: 'Combined PDF',              run: runImagesToCombinedPdf,        multi: 'combined' },
      { label: 'Combined Searchable PDF',   run: runImagesToSearchablePdf,      multi: 'combined' }
    ]
  };
  ROUTES.jpeg = ROUTES.jpg;
  ROUTES.heif = ROUTES.heic;

  // Normalize an extension to its bucket key.
  function bucketOf(ext) {
    if (ext === 'jpeg') return 'jpg';
    if (ext === 'heif') return 'heic';
    return ext;
  }

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
          '<p>or <strong>click to browse</strong>. Multiple files of the same type are fine.</p>' +
          '<p style="font-size:0.85rem">EPUB &middot; PDF &middot; CBZ &middot; HEIC &middot; JPG &middot; PNG &middot; WEBP</p>' +
          '<input type="file" id="uniInput" multiple>' +
        '</div>' +
        '<div id="uniPicker" class="universal-picker" hidden>' +
          '<ul class="uni-files" id="uniFiles"></ul>' +
          '<label class="uni-target">Convert to: <select id="uniTarget"></select></label>' +
          '<div class="actions">' +
            '<button class="btn" id="uniGo">Convert</button>' +
            '<button class="btn btn-secondary" id="uniClear" type="button">Reset</button>' +
          '</div>' +
        '</div>' +
        '<div class="progress" id="uniProgressWrap" style="display:none"><div class="progress-bar" id="uniProgress"></div></div>' +
        '<div id="uniStatus" class="status hidden"></div>' +
      '</div>';

    var dz       = container.querySelector('#uniDrop');
    var input    = container.querySelector('#uniInput');
    var picker   = container.querySelector('#uniPicker');
    var filesEl  = container.querySelector('#uniFiles');
    var targetEl = container.querySelector('#uniTarget');
    var clearBtn = container.querySelector('#uniClear');
    var goBtn    = container.querySelector('#uniGo');
    var progWrap = container.querySelector('#uniProgressWrap');
    var progBar  = container.querySelector('#uniProgress');
    var statusEl = container.querySelector('#uniStatus');

    var files = [];     // accumulated files
    var bucket = null;  // normalized extension shared by all files
    var done = false;

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
      files = [];
      bucket = null;
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

    function renderList() {
      filesEl.innerHTML = '';
      files.forEach(function (f, i) {
        var li = document.createElement('li');
        li.className = 'uni-file';
        li.innerHTML = '<span class="uni-name"></span> <span class="uni-size"></span> ' +
                       '<button type="button" class="remove" title="Remove">&times;</button>';
        li.querySelector('.uni-name').textContent = f.name;
        li.querySelector('.uni-size').textContent = '(' + fmtBytes(f.size) + ')';
        li.querySelector('.remove').addEventListener('click', function () {
          files.splice(i, 1);
          if (files.length === 0) { reset(); return; }
          renderList();
          renderTargets();
        });
        filesEl.appendChild(li);
      });
    }

    function renderTargets() {
      var routes = ROUTES[bucket] || [];
      var multi = files.length > 1;
      targetEl.innerHTML = '';
      // For multi-file: 'each' routes are listed first (default behavior),
      // followed by 'combined' routes. For single-file: drop the combined ones.
      routes.forEach(function (r, i) {
        if (!multi && r.multi === 'combined') return;
        var opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = (multi && r.multi === 'each') ? (r.label + ' (each file)') : r.label;
        targetEl.appendChild(opt);
      });
    }

    function accept(list) {
      clearStatus();
      if (!list || !list.length) return;
      // Determine the bucket from the first incoming file (or the existing one).
      var firstExt = bucketOf(extOf(list[0].name));
      if (!ROUTES[firstExt]) {
        setStatus('error', 'Sorry, .' + (extOf(list[0].name) || 'this file') + ' isn\u2019t supported yet. Try EPUB, PDF, CBZ, HEIC, JPG, PNG, or WEBP.');
        return;
      }
      if (bucket && bucket !== firstExt) {
        setStatus('error', 'These files are .' + firstExt + ' but the batch is .' + bucket + '. Reset to switch.');
        return;
      }
      var rejected = 0;
      for (var i = 0; i < list.length; i++) {
        var ext = bucketOf(extOf(list[i].name));
        if (ext !== firstExt) { rejected++; continue; }
        files.push(list[i]);
      }
      bucket = firstExt;
      renderList();
      renderTargets();
      dz.style.display = 'none';
      picker.hidden = false;
      if (rejected > 0) {
        setStatus('info', 'Skipped ' + rejected + ' file(s) that didn\u2019t match .' + bucket + '. Drop one type at a time.');
      }
    }

    dz.addEventListener('click', function () { input.click(); });
    input.addEventListener('change', function (e) {
      if (e.target.files && e.target.files.length) accept(Array.prototype.slice.call(e.target.files));
    });
    ['dragenter', 'dragover'].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add('dragover'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove('dragover'); });
    });
    dz.addEventListener('drop', function (e) {
      var dropped = e.dataTransfer && e.dataTransfer.files;
      if (dropped && dropped.length) accept(Array.prototype.slice.call(dropped));
    });

    clearBtn.addEventListener('click', reset);

    goBtn.addEventListener('click', async function () {
      if (done) { reset(); return; }
      if (!files.length) return;
      var routes = ROUTES[bucket] || [];
      var route = routes[parseInt(targetEl.value, 10) || 0];
      if (!route) return;
      goBtn.disabled = true;
      goBtn.textContent = 'Converting\u2026';
      progWrap.style.display = 'block';
      setProgress(2);
      setStatus('info', 'Loading converter\u2026');
      try {
        var result;
        var onProg = function (p, m) { setProgress(p); if (m) setStatus('info', m); };
        if (route.multi === 'combined') {
          result = await route.run(files, onProg);
        } else if (files.length === 1) {
          result = await route.run(files[0], onProg);
        } else {
          // 'each' on multiple inputs: ZIP the outputs.
          result = await runEachZipped(route.run)(files, onProg);
        }
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
