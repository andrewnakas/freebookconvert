/*
 * Ebook -> audiobook: chapter picker, neural TTS in js/tts-worker.js,
 * resumable progress in IndexedDB, export as MP3 zip or chaptered M4B.
 *
 * Needs on the page: common.js, epub-parser.js, pdf-to-epub.js, book-text.js,
 * audio-core.js, m4b.js.
 */
(function (global) {
  // Curated from Kokoro's own quality grades (A to C+); the D/F voices are left out.
  var VOICES = [
    ['af_heart', 'Heart · US female (best)'],
    ['af_bella', 'Bella · US female'],
    ['am_michael', 'Michael · US male'],
    ['am_fenrir', 'Fenrir · US male, deeper'],
    ['am_puck', 'Puck · US male, lively'],
    ['af_nicole', 'Nicole · US female, soft'],
    ['bf_emma', 'Emma · British female'],
    ['bm_george', 'George · British male'],
    ['bm_fable', 'Fable · British male']
  ];
  var WORDS_PER_SEC = 2.6;   // ~155 wpm narration at 1x, for estimates only

  // ---------- IndexedDB: finished chapters survive a closed tab --------------

  var dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise(function (resolve, reject) {
      var req = indexedDB.open('fbc_tts', 1);
      req.onupgradeneeded = function () { req.result.createObjectStore('chapters'); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    dbp.catch(function () { dbp = null; });
    return dbp;
  }
  function idb(mode, fn) {
    return db().then(function (d) {
      return new Promise(function (resolve, reject) {
        var tx = d.transaction('chapters', mode);
        var r = fn(tx.objectStore('chapters'));
        tx.oncomplete = function () { resolve(r && r.result); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }
  var store = {
    get: function (k) { return idb('readonly', function (s) { return s.get(k); }).catch(function () { return null; }); },
    put: function (k, v) { return idb('readwrite', function (s) { s.put(v, k); }).catch(function () {}); },
    // Drop chapters nobody has touched in 30 days so storage doesn't grow
    // forever. (Never other *recent* books: switching books mid-way through
    // must not throw away hours of generated audio.)
    pruneOld: function (days) {
      var cutoff = Date.now() - days * 864e5;
      return idb('readwrite', function (s) {
        var req = s.openCursor();
        req.onsuccess = function () {
          var c = req.result;
          if (!c) return;
          if (!c.value || !(c.value.t > cutoff)) c.delete();
          c.continue();
        };
      }).catch(function () {});
    }
  };

  // ---------- worker ------------------------------------------------------------

  function Engine() {
    var worker = null, ready = null, handlers = {}, nextId = 1, loadCb = null, device = null;
    function ensure(wanted, onLoad) { // wanted: backend name, 'wasm' today
      loadCb = onLoad;
      if (ready) return ready;
      worker = new Worker('/js/tts-worker.js', { type: 'module' });
      ready = new Promise(function (resolve, reject) {
        worker.onmessage = function (e) {
          var m = e.data;
          if (m.type === 'load') { if (loadCb) loadCb(m.progress); return; }
          if (m.type === 'ready') { device = m.device; resolve(m.device); return; }
          if (m.type === 'error' && !m.id) { reject(new Error(m.message)); return; }
          var h = handlers[m.id];
          if (h) h(m);
        };
        worker.onerror = function (e) {
          var err = new Error('The voice engine failed to start' + (e.message ? ': ' + e.message : '') + '.');
          reject(err);
          Object.keys(handlers).forEach(function (k) { handlers[k]({ type: 'error', message: err.message }); });
        };
      });
      ready.catch(function () { worker.terminate(); worker = null; ready = null; });
      worker.postMessage({ type: 'init', device: wanted });
      return ready;
    }
    // Resolves {mp3, seconds}; onProgress({done,total,seconds,elapsed}).
    function speak(chunks, voice, speed, onProgress) {
      var id = nextId++;
      var p = new Promise(function (resolve, reject) {
        handlers[id] = function (m) {
          if (m.type === 'progress') { onProgress && onProgress(m); return; }
          delete handlers[id];
          if (m.type === 'done') resolve({ mp3: m.mp3, seconds: m.seconds });
          else if (m.type === 'cancelled') reject(Object.assign(new Error('Stopped.'), { cancelled: true }));
          else reject(new Error(m.message || 'Speech generation failed.'));
        };
        worker.postMessage({ type: 'speak', id: id, chunks: chunks, voice: voice, speed: speed });
      });
      p.id = id;
      return p;
    }
    function cancel(id) { if (worker) worker.postMessage({ type: 'cancel', id: id }); }
    return { ensure: ensure, speak: speak, cancel: cancel, device: function () { return device; } };
  }

  // Announce the chapter title, unless the chapter text already opens with
  // its heading (EPUBs usually do), which would read it out twice.
  function spokenText(c) {
    var norm = function (t) { return t.toLowerCase().replace(/[^a-z0-9]+/g, ''); };
    var head = norm(c.text.slice(0, c.title.length + 20));
    if (head.indexOf(norm(c.title)) === 0) return c.text;
    return c.title + '.\n\n' + c.text;
  }

  function estSeconds(words, speed) { return words / WORDS_PER_SEC / (speed || 1); }

  function fmtEta(sec) {
    if (!isFinite(sec) || sec <= 0) return '';
    if (sec < 90) return 'under 2 min';
    if (sec < 3600) return Math.round(sec / 60) + ' min';
    return (sec / 3600).toFixed(1) + ' h';
  }

  // ---------- controller --------------------------------------------------------

  // ui: {dropzone, input, status, progressWrap, progressBar, setup, meta,
  //      list, voice, speed, previewBtn, goBtn, stopBtn, zipBtn, m4bBtn, player}
  function App(ui) {
    var engine = Engine();
    var book = null, fileKey = '', chapters = [], running = false, current = null, wakeLock = null;
    var measured = null; // seconds of audio per second of compute, from real runs

    VOICES.forEach(function (v) {
      var o = document.createElement('option');
      o.value = v[0]; o.textContent = v[1];
      ui.voice.appendChild(o);
    });
    function jobPrefix() { return fileKey + '|' + ui.voice.value + '|' + ui.speed.value + '|'; }

    function status(kind, msg) { CV.setStatus(ui.status, kind, msg); }

    function selected() { return chapters.filter(function (c) { return c.checkbox.checked; }); }

    function refreshButtons() {
      var done = chapters.filter(function (c) { return c.blob; });
      var todo = selected().filter(function (c) { return !c.blob; });
      ui.goBtn.disabled = running || !todo.length;
      ui.goBtn.textContent = done.length && todo.length ? 'Continue (' + todo.length + ' left)' : 'Create audiobook';
      ui.stopBtn.hidden = !running;
      ui.previewBtn.disabled = running || !selected().length;
      ui.zipBtn.disabled = running || !done.length;
      ui.m4bBtn.disabled = running || !done.length;
      ui.voice.disabled = ui.speed.disabled = running;
      var total = todo.reduce(function (s, c) { return s + c.words; }, 0);
      var audio = estSeconds(total, +ui.speed.value);
      var note = todo.length
        ? todo.length + ' chapter' + (todo.length > 1 ? 's' : '') + ' to go · about ' + AudioCore.fmtDuration(audio) + ' of audio'
        : done.length ? 'All selected chapters are ready to download.' : 'Select chapters to narrate.';
      if (todo.length && measured) note += ' · roughly ' + fmtEta(audio / measured) + ' to generate on this device';
      ui.meta.querySelector('.plan').textContent = note;
    }

    function rowState(c, text, cls) {
      c.stateEl.textContent = text;
      c.row.className = 'tts-row' + (cls ? ' ' + cls : '');
    }

    function renderList() {
      ui.list.innerHTML = '';
      chapters.forEach(function (c, i) {
        var li = document.createElement('li');
        li.className = 'tts-row';
        li.innerHTML = '<label><input type="checkbox"> <span class="t"></span></label>' +
          '<span class="w"></span><span class="st"></span>' +
          '<button type="button" class="icon-btn play" aria-label="Play chapter" hidden>&#9654;</button>';
        c.row = li;
        c.checkbox = li.querySelector('input');
        c.checkbox.checked = c.words >= 40;   // skip copyright pages, blank title pages
        c.checkbox.addEventListener('change', refreshButtons);
        li.querySelector('.t').textContent = (i + 1) + '. ' + c.title;
        li.querySelector('.w').textContent = c.words.toLocaleString() + ' words';
        c.stateEl = li.querySelector('.st');
        c.playBtn = li.querySelector('.play');
        c.playBtn.addEventListener('click', function () { play(c); });
        ui.list.appendChild(li);
      });
    }

    function play(c) {
      if (!c.blob) return;
      if (ui.player.dataset.url) URL.revokeObjectURL(ui.player.dataset.url);
      var url = URL.createObjectURL(c.blob);
      ui.player.dataset.url = url;
      ui.player.src = url;
      ui.player.hidden = false;
      ui.player.play().catch(function () {});
    }

    // Look up chapters already generated with the current voice + speed.
    async function restore() {
      var prefix = jobPrefix(), found = 0;
      for (var i = 0; i < chapters.length; i++) {
        var c = chapters[i];
        var rec = await store.get(prefix + i);
        c.blob = rec ? rec.blob : null;
        c.seconds = rec ? rec.seconds : 0;
        c.playBtn.hidden = !c.blob;
        if (c.blob) { found++; rowState(c, '✓ ' + AudioCore.fmtDuration(c.seconds), 'done'); }
        else rowState(c, '', '');
      }
      return found;
    }

    async function open(file) {
      stop();
      status('info', 'Opening ' + file.name + '…');
      try {
        book = await BookText.load(file, function (p, m) { status('info', m); });
      } catch (e) {
        status('error', 'Could not open this file: ' + (e.message || e));
        return;
      }
      fileKey = BookText.bookKey(file);
      store.pruneOld(30);
      chapters = book.chapters.map(function (c) { return { title: c.title, text: c.text, words: c.words }; });
      ui.meta.querySelector('.bt').textContent = book.title + (book.author ? ' · ' + book.author : '');
      renderList();
      ui.setup.hidden = false;
      var found = await restore();
      refreshButtons();
      var left = selected().filter(function (c) { return !c.blob; }).length;
      status(found ? 'success' : 'info', found
        ? 'Welcome back. ' + found + ' chapter' + (found > 1 ? 's are' : ' is') + ' already done.' +
          (left ? ' Press Continue to finish the rest.' : ' Download them below, or tick more chapters to narrate.')
        : 'Pick a voice, preview it, then press Create audiobook.');
    }

    async function loadEngine() {
      if (engine.device()) return engine.device();
      ui.progressWrap.style.display = 'block';
      status('info', 'Downloading the voice model (92 MB, one time; cached for next visit)…');
      var dev = await engine.ensure('wasm', function (p) {
        CV.setProgress(ui.progressBar, p * 100);
        status('info', 'Downloading the voice model (92 MB, one time)… ' + Math.round(p * 100) + '%');
      });
      CV.track('tts_model_loaded', { backend: dev });
      return dev;
    }

    async function lockScreen() {
      try { if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* denied */ }
    }
    function unlockScreen() { if (wakeLock) { wakeLock.release().catch(function () {}); wakeLock = null; } }

    function beforeUnload(e) { e.preventDefault(); e.returnValue = ''; }

    async function preview() {
      var c = selected()[0];
      if (!c) return;
      running = true; refreshButtons();
      try {
        await loadEngine();
        status('info', 'Generating a short preview…');
        var text = BookText.chunks(c.text, 220)[0] || c.title;
        var t0 = performance.now();
        current = engine.speak([text], ui.voice.value, +ui.speed.value);
        var res = await current;
        measured = res.seconds / ((performance.now() - t0) / 1000);
        play({ blob: new Blob([res.mp3], { type: 'audio/mpeg' }) });
        status('success', 'Preview ready. This device generates about ' + measured.toFixed(1) +
          ' seconds of audio per second' + (measured < 1 ? ', which is slower than real time. A long book will take a while; you can stop and continue later.' : '.'));
      } catch (e) {
        if (!e.cancelled) status('error', 'Preview failed: ' + (e.message || e));
      } finally {
        running = false; current = null; ui.progressWrap.style.display = 'none'; refreshButtons();
      }
    }

    async function generate() {
      var todo = selected().filter(function (c) { return !c.blob; });
      if (!todo.length) return;
      running = true; refreshButtons();
      window.addEventListener('beforeunload', beforeUnload);
      lockScreen();
      var prefix = jobPrefix();
      var voice = ui.voice.value, speed = +ui.speed.value;
      var totalWords = todo.reduce(function (s, c) { return s + c.words; }, 0), wordsDone = 0;
      var audioDone = 0, computeDone = 0;
      CV.track('conversion_start', { target: 'tts', count: todo.length });
      try {
        await loadEngine();
        ui.progressWrap.style.display = 'block';
        for (var k = 0; k < todo.length; k++) {
          var c = todo[k];
          var chunks = BookText.chunks(spokenText(c));
          rowState(c, 'Generating…', 'active');
          var t0 = performance.now();
          current = engine.speak(chunks, voice, speed, function (m) {
            var chapterFrac = m.done / m.total;
            var overall = (wordsDone + c.words * chapterFrac) / totalWords;
            CV.setProgress(ui.progressBar, overall * 100);
            var rate = (audioDone + m.seconds) / (computeDone + m.elapsed);
            if (rate > 0) measured = rate;
            var remainingAudio = estSeconds(totalWords - wordsDone - c.words * chapterFrac, speed);
            rowState(c, Math.round(chapterFrac * 100) + '%', 'active');
            status('info', 'Chapter ' + (k + 1) + ' of ' + todo.length + ': ' + c.title.slice(0, 50) +
              ' · ' + Math.round(overall * 100) + '% overall' +
              (rate > 0 ? ' · about ' + fmtEta(remainingAudio / rate) + ' left' : ''));
          });
          var res = await current;
          audioDone += res.seconds;
          computeDone += (performance.now() - t0) / 1000;
          c.blob = new Blob([res.mp3], { type: 'audio/mpeg' });
          c.seconds = res.seconds;
          await store.put(prefix + chapters.indexOf(c), { blob: c.blob, seconds: c.seconds, title: c.title, t: Date.now() });
          c.playBtn.hidden = false;
          rowState(c, '✓ ' + AudioCore.fmtDuration(c.seconds), 'done');
          wordsDone += c.words;
          refreshButtons();
        }
        CV.setProgress(ui.progressBar, 100);
        status('success', 'All done. Download the MP3s or make a single M4B audiobook below.');
        CV.track('audio_generated', { chapters: todo.length, seconds: Math.round(audioDone), backend: engine.device() });
      } catch (e) {
        if (e.cancelled) status('info', 'Stopped. Finished chapters are saved in this browser. Press Continue any time to pick up.');
        else { console.error(e); status('error', 'Generation failed: ' + (e.message || e)); }
        todo.forEach(function (c) { if (!c.blob) rowState(c, '', ''); });
      } finally {
        running = false; current = null;
        window.removeEventListener('beforeunload', beforeUnload);
        unlockScreen();
        refreshButtons();
      }
    }

    function stop() {
      if (current && current.id) engine.cancel(current.id);
    }

    function doneInOrder() { return chapters.filter(function (c) { return c.blob; }); }

    function baseName() { return AudioCore.safeName(book.title || 'Audiobook'); }

    async function exportZip() {
      var done = doneInOrder();
      await CV.load('jszip');
      var zip = new JSZip(), pad = Math.max(2, String(done.length).length);
      done.forEach(function (c, i) {
        zip.file(String(i + 1).padStart(pad, '0') + ' - ' + AudioCore.safeName(c.title, 60) + '.mp3', c.blob, { compression: 'STORE' });
      });
      var blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
      CV.downloadBlob(blob, baseName() + ' (MP3).zip');
      CV.track('audio_export_complete', { out_ext: 'zip', chapters: done.length });
    }

    async function exportM4b() {
      var done = doneInOrder();
      running = true; refreshButtons();
      ui.progressWrap.style.display = 'block';
      try {
        var files = done.map(function (c, i) {
          return new File([c.blob], String(i + 1).padStart(3, '0') + '.mp3', { type: 'audio/mpeg' });
        });
        var res = await Mp3ToM4b.convert(files, {
          title: book.title, author: book.author, quality: 'voice',
          titles: done.map(function (c) { return c.title; })
        }, function (p, m) { CV.setProgress(ui.progressBar, p); status('info', m); });
        CV.downloadBlob(res.blob, res.filename);
        CV.track('audio_export_complete', { out_ext: 'm4b', chapters: done.length });
        status('success', 'Saved ' + res.filename + ' (' + done.length + ' chapters, ' + AudioCore.fmtDuration(res.duration) + ').');
      } catch (e) {
        console.error(e);
        status('error', 'Could not build the M4B: ' + (e.message || e));
      } finally {
        running = false; refreshButtons();
      }
    }

    CV.bindDropzone(ui.dropzone, ui.input, function (files) { if (files[0]) open(files[0]); }, ['.epub', '.pdf', '.txt']);
    ui.goBtn.addEventListener('click', generate);
    ui.stopBtn.addEventListener('click', stop);
    ui.previewBtn.addEventListener('click', preview);
    ui.zipBtn.addEventListener('click', exportZip);
    ui.m4bBtn.addEventListener('click', exportM4b);
    // Finished chapters are stored per voice + speed; switching either shows
    // that combination's progress instead.
    [ui.voice, ui.speed].forEach(function (el) {
      el.addEventListener('change', function () { if (book) restore().then(refreshButtons); });
    });
  }

  global.EbookAudiobook = { App: App, VOICES: VOICES };
})(window);
