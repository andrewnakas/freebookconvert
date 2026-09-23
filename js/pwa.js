/*
 * Installable app support: registers the service worker, offers "Install"
 * after a successful conversion (the moment the site has proven useful), and
 * receives files when the installed app is used to "Open with" a file.
 */
(function () {
  if (!('serviceWorker' in navigator) || location.protocol !== 'https:' && location.hostname !== 'localhost') return;

  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js').catch(function () { /* private mode, etc. */ });
  });

  // ---- install prompt --------------------------------------------------------
  var DISMISS_KEY = 'fbc_install_dismissed';
  var deferred = null;

  function dismissed() { try { return !!localStorage.getItem(DISMISS_KEY); } catch (e) { return true; } }

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferred = e;
  });
  window.addEventListener('appinstalled', function () {
    if (window.CV) CV.track('pwa_install', {});
    var bar = document.getElementById('fbc-install');
    if (bar) bar.remove();
  });

  function offerInstall() {
    if (!deferred || dismissed() || document.getElementById('fbc-install')) return;
    var bar = document.createElement('div');
    bar.id = 'fbc-install';
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'Install app');
    bar.innerHTML = '<p><strong>Install FreeBookConvert?</strong> Works offline and opens files straight from your computer.</p>' +
      '<div><button type="button" class="btn" data-a="install">Install</button> ' +
      '<button type="button" class="btn btn-secondary" data-a="no">Not now</button></div>';
    bar.addEventListener('click', function (e) {
      var a = e.target.getAttribute && e.target.getAttribute('data-a');
      if (!a) return;
      if (a === 'install' && deferred) {
        deferred.prompt();
        deferred.userChoice.then(function (c) { if (window.CV) CV.track('pwa_prompt', { target: c.outcome }); });
        deferred = null;
      } else {
        try { localStorage.setItem(DISMISS_KEY, '1'); } catch (err) {}
      }
      bar.remove();
    });
    document.body.appendChild(bar);
  }
  document.addEventListener('fbc:converted', function () { setTimeout(offerInstall, 1500); });

  // ---- "Open with" from the OS (installed app, Chromium) --------------------
  if ('launchQueue' in window) {
    window.addEventListener('load', function () {
      window.launchQueue.setConsumer(async function (params) {
        if (!params.files || !params.files.length) return;
        var files = await Promise.all(params.files.map(function (h) { return h.getFile(); }));
        var input = document.getElementById('fileInput') || document.getElementById('uniInput');
        if (!input) return;
        var dt = new DataTransfer();
        files.forEach(function (f) { dt.items.add(f); });
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        if (window.CV) CV.track('file_selected', { count: files.length, method: 'os_open' });
      });
    });
  }
})();
