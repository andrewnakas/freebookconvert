/*
 * Universal converter entry: drop a file, pick a target format, redirect to the right converter.
 *
 * Handoff strategy:
 *   - Under 4 MB: stash the file in sessionStorage as base64; target page auto-loads it.
 *   - Larger: redirect with ?prefill=name hint; target page shows a friendly "drop again" prompt.
 */
(function (global) {
  var MAX_HANDOFF_BYTES = 4 * 1024 * 1024;

  // Extension -> [{ext, label, path}]
  var ROUTES = {
    epub: [
      { ext: 'pdf', label: 'PDF',  path: '/pages/epub-to-pdf.html' },
      { ext: 'txt', label: 'TXT (plain text)', path: '/pages/epub-to-txt.html' }
    ],
    pdf: [
      { ext: 'epub', label: 'EPUB (ebook)', path: '/pages/pdf-to-epub.html' },
      { ext: 'jpg',  label: 'JPG (page images)', path: '/pages/pdf-to-jpg.html' },
      { ext: 'png',  label: 'PNG (page images)', path: '/pages/pdf-to-jpg.html' }
    ],
    cbz: [{ ext: 'pdf', label: 'PDF', path: '/pages/cbz-to-pdf.html' }],
    zip: [{ ext: 'pdf', label: 'PDF (as comic archive)', path: '/pages/cbz-to-pdf.html' }],
    heic: [
      { ext: 'pdf', label: 'PDF', path: '/pages/heic-to-pdf.html' },
      { ext: 'jpg', label: 'JPG', path: '/pages/heic-to-jpg.html' },
      { ext: 'png', label: 'PNG', path: '/pages/heic-to-png.html' }
    ],
    jpg: [
      { ext: 'png',  label: 'PNG',  path: '/pages/jpg-to-png.html' },
      { ext: 'webp', label: 'WEBP', path: '/pages/jpg-to-webp.html' },
      { ext: 'pdf',  label: 'PDF',  path: '/pages/images-to-pdf.html' }
    ],
    png: [
      { ext: 'jpg',  label: 'JPG',  path: '/pages/png-to-jpg.html' },
      { ext: 'webp', label: 'WEBP', path: '/pages/png-to-webp.html' },
      { ext: 'pdf',  label: 'PDF',  path: '/pages/images-to-pdf.html' }
    ],
    webp: [
      { ext: 'jpg', label: 'JPG', path: '/pages/webp-to-jpg.html' },
      { ext: 'png', label: 'PNG', path: '/pages/webp-to-png.html' },
      { ext: 'pdf', label: 'PDF', path: '/pages/images-to-pdf.html' }
    ]
  };
  ROUTES.jpeg = ROUTES.jpg;
  ROUTES.heif = ROUTES.heic;

  function extOf(name) {
    var m = name.toLowerCase().match(/\.([a-z0-9]+)$/);
    return m ? m[1] : '';
  }

  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(2) + ' MB';
  }

  function blobToBase64(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () {
        // r.result is a data URL: data:<mime>;base64,<payload>
        resolve(r.result);
      };
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }

  async function handoff(file, route) {
    var url = route.path;
    if (file.size <= MAX_HANDOFF_BYTES) {
      try {
        var dataUrl = await blobToBase64(file);
        sessionStorage.setItem('fbc_handoff_v1', JSON.stringify({
          name: file.name,
          type: file.type,
          dataUrl: dataUrl,
          ts: Date.now()
        }));
        window.location.href = url;
        return;
      } catch (e) {
        // Storage quota or other failure: fall through to prompt mode.
        console.warn('Handoff storage failed, falling back to prompt:', e);
      }
    }
    // Big-file fallback: pass just the name as a hint so the destination page can greet the user.
    window.location.href = url + '?prefill=' + encodeURIComponent(file.name);
  }

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
          '<button class="btn" id="uniGo">Continue</button>' +
        '</div>' +
        '<div id="uniError" class="status error" hidden></div>' +
      '</div>';

    var dz = container.querySelector('#uniDrop');
    var input = container.querySelector('#uniInput');
    var picker = container.querySelector('#uniPicker');
    var nameEl = container.querySelector('.uni-name');
    var sizeEl = container.querySelector('.uni-size');
    var targetEl = container.querySelector('#uniTarget');
    var clearBtn = container.querySelector('#uniClear');
    var goBtn = container.querySelector('#uniGo');
    var errEl = container.querySelector('#uniError');
    var current = null;

    function showError(msg) {
      errEl.textContent = msg;
      errEl.hidden = false;
    }
    function clearError() {
      errEl.hidden = true;
      errEl.textContent = '';
    }
    function reset() {
      current = null;
      picker.hidden = true;
      dz.style.display = '';
      input.value = '';
      clearError();
    }

    function accept(file) {
      clearError();
      var ext = extOf(file.name);
      var routes = ROUTES[ext];
      if (!routes) {
        showError('We don\u2019t support .' + (ext || 'this file') + ' yet. Try EPUB, PDF, CBZ, HEIC, JPG, PNG, or WEBP \u2014 or request it on the Contact page.');
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
    goBtn.addEventListener('click', function () {
      if (!current) return;
      var route = current.routes[parseInt(targetEl.value, 10) || 0];
      goBtn.disabled = true;
      goBtn.textContent = 'Loading\u2026';
      handoff(current.file, route).catch(function (e) {
        console.error(e);
        showError('Could not prepare the file. Please open ' + route.path + ' directly.');
        goBtn.disabled = false;
        goBtn.textContent = 'Continue';
      });
    });
  }

  global.UniversalEntry = { init: init };
})(window);
