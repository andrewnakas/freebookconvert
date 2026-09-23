/*
 * Shared audio plumbing: an ffmpeg.wasm session plus the chapter-metadata and
 * timing helpers the audiobook tools share.
 *
 * ffmpeg is the single-thread build. The multi-thread build needs
 * SharedArrayBuffer, which needs COOP/COEP `require-corp` headers, and those
 * would block the AdSense iframes on every page.
 */
(function (global) {
  var CORE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd/';
  var CORE_JS = {
    url: CORE + 'ffmpeg-core.js',
    sri: 'sha384-sKfkiFtvUk+vexk+0EUhEh366190/4WpgUAsUvaxEfyg7+E1Zt5Y5hrsU808g8Q9'
  };
  var CORE_WASM = {
    url: CORE + 'ffmpeg-core.wasm',
    sri: 'sha384-U1VDhkPYrM3wTCT4/vjSpSsKqG/UjljYrYCI4hBSJ02svbCkxuCi6U6u/peg5vpW',
    bytes: 32232419
  };

  // fetch() with a download-progress callback, then verify the SRI hash
  // ourselves (fetch's own `integrity` option gives no progress events).
  async function fetchVerified(asset, type, onBytes) {
    var res = await fetch(asset.url);
    if (!res.ok) throw new Error('Could not download the audio engine (HTTP ' + res.status + ').');
    var total = asset.bytes || +res.headers.get('content-length') || 0;
    var reader = res.body.getReader();
    var chunks = [], got = 0;
    for (;;) {
      var r = await reader.read();
      if (r.done) break;
      chunks.push(r.value);
      got += r.value.length;
      if (onBytes && total) onBytes(got / total);
    }
    var blob = new Blob(chunks, { type: type });
    var digest = await crypto.subtle.digest('SHA-384', await blob.arrayBuffer());
    var b64 = btoa(String.fromCharCode.apply(null, new Uint8Array(digest)));
    if ('sha384-' + b64 !== asset.sri) {
      throw new Error('The audio engine download was corrupted or altered. Reload the page and try again.');
    }
    return URL.createObjectURL(blob);
  }

  // ---------- ffmpeg session --------------------------------------------------

  var sessionPromise = null;

  // Resolves to { exec, writeFile, readFile, deleteFile, onLog, terminate }.
  // The engine is ~31 MB, fetched once per page (the browser HTTP cache makes
  // later visits fast). onLoadProgress(fraction) reports the download.
  function ffmpeg(onLoadProgress) {
    if (sessionPromise) return sessionPromise;
    sessionPromise = (async function () {
      var coreURL = await fetchVerified(CORE_JS, 'text/javascript');
      var wasmURL = await fetchVerified(CORE_WASM, 'application/wasm', onLoadProgress);
      var worker = new Worker('/js/ffmpeg-worker.js');
      var nextId = 1, waiting = {}, logListeners = [];

      worker.onmessage = function (e) {
        var m = e.data;
        if (m.type === 'LOG') { logListeners.forEach(function (fn) { fn(m.data); }); return; }
        var w = waiting[m.id];
        if (!w) return;
        delete waiting[m.id];
        if (m.type === 'ERROR') w.reject(new Error(m.data)); else w.resolve(m.data);
      };
      worker.onerror = function (e) {
        var err = new Error('The audio engine crashed' + (e.message ? ': ' + e.message : '') +
          '. This usually means the files are too large for this device’s memory.');
        Object.keys(waiting).forEach(function (k) { waiting[k].reject(err); });
        waiting = {};
        sessionPromise = null;
      };

      function call(type, data, transfer) {
        return new Promise(function (resolve, reject) {
          var id = nextId++;
          waiting[id] = { resolve: resolve, reject: reject };
          worker.postMessage({ id: id, type: type, data: data }, transfer || []);
        });
      }

      await call('LOAD', { coreURL: coreURL, wasmURL: wasmURL });
      CV.track('audio_engine_loaded', {});

      return {
        // Resolves with ffmpeg's exit code. Collects the log so callers can
        // parse durations or show the tail on failure.
        exec: async function (args, onLog) {
          var log = [];
          var fn = function (line) { log.push(line); if (onLog) onLog(line); };
          logListeners.push(fn);
          try {
            var code = await call('EXEC', { args: args });
            return { code: code, log: log };
          } finally {
            logListeners = logListeners.filter(function (f) { return f !== fn; });
          }
        },
        writeFile: async function (path, fileOrBytes) {
          var bytes = fileOrBytes instanceof Uint8Array
            ? fileOrBytes
            : new Uint8Array(await fileOrBytes.arrayBuffer());
          return call('WRITE_FILE', { path: path, data: bytes }, [bytes.buffer]);
        },
        readFile: function (path) { return call('READ_FILE', { path: path }); },
        deleteFile: function (path) { return call('DELETE_FILE', { path: path }); },
        terminate: function () { worker.terminate(); sessionPromise = null; }
      };
    })();
    sessionPromise.catch(function () { sessionPromise = null; });
    return sessionPromise;
  }

  // ---------- log parsing -----------------------------------------------------

  function hmsToSec(h, m, s) { return (+h) * 3600 + (+m) * 60 + parseFloat(s); }

  // "Duration: 00:12:34.56" per "Input #N" block, in input order.
  function inputDurations(log) {
    var out = [], current = -1;
    log.forEach(function (line) {
      var inp = /^Input #(\d+)/.exec(line);
      if (inp) { current = +inp[1]; return; }
      var d = /Duration: (\d+):(\d+):([\d.]+)/.exec(line);
      if (d && current >= 0 && out[current] === undefined) out[current] = hmsToSec(d[1], d[2], d[3]);
    });
    return out;
  }

  // Progress lines look like "size=  1024kB time=00:01:23.45 bitrate=...".
  function progressTime(line) {
    var t = /time=(\d+):(\d+):([\d.]+)/.exec(line);
    return t ? hmsToSec(t[1], t[2], t[3]) : null;
  }

  function lastLines(log, n) {
    return log.filter(function (l) { return l && !/^\s*(size|frame)=/.test(l); }).slice(-(n || 4)).join('\n');
  }

  // ---------- chapter metadata (ffmetadata format) ----------------------------

  function escMeta(s) { return String(s).replace(/([=;#\\\n])/g, '\\$1'); }

  // chapters: [{title, start, end}] in seconds.
  function buildFfmetadata(tags, chapters) {
    var out = [';FFMETADATA1'];
    Object.keys(tags || {}).forEach(function (k) {
      if (tags[k]) out.push(k + '=' + escMeta(tags[k]));
    });
    chapters.forEach(function (c) {
      out.push('', '[CHAPTER]', 'TIMEBASE=1/1000',
        'START=' + Math.round(c.start * 1000),
        'END=' + Math.round(c.end * 1000),
        'title=' + escMeta(c.title));
    });
    return new TextEncoder().encode(out.join('\n') + '\n');
  }

  function parseFfmetadata(text) {
    var tags = {}, chapters = [], cur = null;
    text.split(/\r?\n/).forEach(function (raw) {
      var line = raw.trim();
      if (!line || line[0] === ';' || line[0] === '#') return;
      if (line === '[CHAPTER]') { cur = { timebase: 1 / 1000, title: '' }; chapters.push(cur); return; }
      if (line[0] === '[') { cur = null; return; }
      var eq = line.search(/(?<!\\)=/);
      if (eq < 0) return;
      var key = line.slice(0, eq), val = line.slice(eq + 1).replace(/\\(.)/g, '$1');
      if (!cur) { tags[key.toLowerCase()] = val; return; }
      if (key === 'TIMEBASE') { var p = val.split('/'); cur.timebase = (+p[0]) / (+p[1]); }
      else if (key === 'START') cur.startRaw = +val;
      else if (key === 'END') cur.endRaw = +val;
      else if (key.toLowerCase() === 'title') cur.title = val;
    });
    chapters = chapters.map(function (c, i) {
      return {
        title: c.title || 'Chapter ' + (i + 1),
        start: c.startRaw * c.timebase,
        end: c.endRaw * c.timebase
      };
    });
    return { tags: tags, chapters: chapters };
  }

  // ---------- misc -------------------------------------------------------------

  function fmtDuration(sec) {
    sec = Math.max(0, Math.round(sec));
    var h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
    var mm = (h ? String(m).padStart(2, '0') : String(m));
    return (h ? h + ':' : '') + mm + ':' + String(s).padStart(2, '0');
  }

  // Safe for Windows/macOS/Android file names, keeps it readable.
  function safeName(s, max) {
    return String(s).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max || 80) || 'audio';
  }

  // Natural sort so "Track 2.mp3" comes before "Track 10.mp3".
  function naturalCompare(a, b) {
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  }

  function baseName(name) { return name.replace(/\.[^.]+$/, ''); }

  global.AudioCore = {
    ffmpeg: ffmpeg,
    inputDurations: inputDurations,
    progressTime: progressTime,
    lastLines: lastLines,
    buildFfmetadata: buildFfmetadata,
    parseFfmetadata: parseFfmetadata,
    fmtDuration: fmtDuration,
    safeName: safeName,
    naturalCompare: naturalCompare,
    baseName: baseName
  };
})(window);
