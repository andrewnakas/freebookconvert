/*
 * Receive a file handed off from the homepage universal entry.
 * Reads sessionStorage 'fbc_handoff_v1' (set by universal-entry.js) and reconstructs a File.
 * Also handles ?prefill=<name> for large-file fallback (just shows a hint).
 *
 * Page wires it up:
 *   CV.handoff.receive(['.epub'], function(file) { ...adopt file... });
 */
(function (global) {
  var KEY = 'fbc_handoff_v1';

  function dataUrlToBlob(dataUrl) {
    var parts = dataUrl.split(',');
    var meta = parts[0];
    var data = parts[1] || '';
    var mime = (meta.match(/data:([^;]+)/) || [])[1] || 'application/octet-stream';
    var bin = atob(data);
    var arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }

  function extMatches(name, accept) {
    if (!accept || !accept.length) return true;
    var lower = name.toLowerCase();
    return accept.some(function (a) { return lower.endsWith(a.toLowerCase()); });
  }

  function receive(accept, onFile) {
    try {
      var raw = sessionStorage.getItem(KEY);
      if (raw) {
        sessionStorage.removeItem(KEY); // one-shot
        var payload = JSON.parse(raw);
        if (payload && payload.dataUrl && extMatches(payload.name, accept)) {
          var blob = dataUrlToBlob(payload.dataUrl);
          var file = new File([blob], payload.name, { type: payload.type || blob.type });
          onFile(file);
          return true;
        }
      }
    } catch (e) {
      console.warn('Handoff receive failed:', e);
    }

    // No stored payload — check for the big-file prefill hint.
    var params = new URLSearchParams(window.location.search);
    var prefill = params.get('prefill');
    if (prefill) {
      // Show a hint via the status element if present
      var statusEl = document.getElementById('status');
      if (statusEl && global.CV) {
        global.CV.setStatus(statusEl, 'info',
          'Drop "' + prefill + '" again to convert it. (Large files can\u2019t auto-load between pages.)');
      }
    }
    return false;
  }

  // Hang it off CV namespace if present (most pages have it).
  if (!global.CV) global.CV = {};
  global.CV.handoff = { receive: receive };
})(window);
