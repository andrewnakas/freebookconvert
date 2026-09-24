/*
 * Read an ebook aloud with the browser's built-in voices (Web Speech API).
 * Nothing to download, but no audio file either: speechSynthesis plays
 * straight to the speakers and can't be recorded. For a file, see
 * epub-to-audiobook.
 *
 * Speaks one sentence per utterance. Chrome silently stops utterances longer
 * than ~15 seconds, and sentence granularity also gives us highlighting,
 * click-to-jump, and a resume position that means something.
 */
(function (global) {
  var POS_KEY = 'fbc_readaloud_pos';

  function loadPositions() {
    try { return JSON.parse(localStorage.getItem(POS_KEY)) || {}; } catch (e) { return {}; }
  }
  function savePosition(key, c, s) {
    var all = loadPositions();
    all[key] = { c: c, s: s, t: Date.now() };
    // Keep the 20 most recent books.
    var keys = Object.keys(all).sort(function (a, b) { return all[b].t - all[a].t; });
    keys.slice(20).forEach(function (k) { delete all[k]; });
    try { localStorage.setItem(POS_KEY, JSON.stringify(all)); } catch (e) { /* private mode */ }
  }

  // Apple ships joke voices (Albert, Bad News, Zarvox...) alongside real ones;
  // never offer those for reading a book.
  var NOVELTY = /^(Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Good News|Jester|Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox|Deranged|Hysterical|Pipe Organ|Princess|Junior|Ralph|Fred|Kathy)\b/i;

  // Best first: natural/enhanced/cloud voices, then the system default, then
  // well-known good system voices, then everything else.
  function rank(v) {
    if (/natural|neural|premium|enhanced|google|online/i.test(v.name)) return 0;
    if (v.default) return 1;
    if (/^(Samantha|Ava|Allison|Susan|Tom|Alex|Daniel|Karen|Moira|Serena|Microsoft (Aria|Jenny|Guy))\b/i.test(v.name)) return 2;
    return 3;
  }

  // ui: {text, chapterSel, voiceSel, rateSel, playBtn, prevBtn, nextBtn, where}
  function Reader(ui) {
    var synth = global.speechSynthesis;
    var book = null, key = '', chapter = 0, sents = [], idx = 0, playing = false, gen = 0;

    function voices() {
      var lang = ((book && book.language) || 'en').slice(0, 2).toLowerCase();
      var all = synth.getVoices();
      var match = all.filter(function (v) { return v.lang.toLowerCase().indexOf(lang) === 0; });
      var pool = match.length ? match : all;
      var seen = {};
      var real = pool.filter(function (v) {
        if (NOVELTY.test(v.name) || seen[v.name]) return false;   // Safari lists variants twice
        seen[v.name] = true;
        return true;
      });
      return (real.length ? real : pool).slice().sort(function (a, b) {
        var loc = (navigator.language || '').toLowerCase();
        var near = function (v) { return v.lang.toLowerCase().replace('_', '-') === loc ? 0 : 1; };
        return rank(a) - rank(b) || near(a) - near(b) || a.name.localeCompare(b.name);
      });
    }

    function fillVoices() {
      var list = voices();
      var prev = ui.voiceSel.value;
      ui.voiceSel.innerHTML = '';
      list.forEach(function (v) {
        var o = document.createElement('option');
        o.value = v.name;
        o.textContent = v.name + ' (' + v.lang + ')';
        ui.voiceSel.appendChild(o);
      });
      if (prev && list.some(function (v) { return v.name === prev; })) ui.voiceSel.value = prev;
    }
    if (synth) {
      fillVoices();
      synth.addEventListener && synth.addEventListener('voiceschanged', fillVoices);
    }

    function renderChapter() {
      sents = BookText.sentences(book.chapters[chapter].text);
      ui.text.innerHTML = '';
      var frag = document.createDocumentFragment();
      var h = document.createElement('h2');
      h.textContent = book.chapters[chapter].title;
      frag.appendChild(h);
      sents.forEach(function (s, i) {
        var span = document.createElement('span');
        span.className = 'sent';
        span.dataset.i = i;
        span.textContent = s + ' ';
        frag.appendChild(span);
      });
      ui.text.appendChild(frag);
      ui.chapterSel.value = String(chapter);
    }

    function highlight() {
      var old = ui.text.querySelector('.sent.reading');
      if (old) old.classList.remove('reading');
      var cur = ui.text.querySelector('.sent[data-i="' + idx + '"]');
      if (cur) {
        cur.classList.add('reading');
        var r = cur.getBoundingClientRect(), box = ui.text.getBoundingClientRect();
        if (r.top < box.top || r.bottom > box.bottom) cur.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
      ui.where.textContent = 'Chapter ' + (chapter + 1) + ' of ' + book.chapters.length +
        ' · sentence ' + (idx + 1) + ' of ' + sents.length;
      savePosition(key, chapter, idx);
    }

    function speakCurrent() {
      var my = ++gen;
      synth.cancel();
      if (idx >= sents.length) {
        if (chapter + 1 < book.chapters.length) { chapter++; idx = 0; renderChapter(); }
        else { stop(); ui.where.textContent = 'Finished the book.'; return; }
      }
      highlight();
      var u = new SpeechSynthesisUtterance(sents[idx]);
      var v = synth.getVoices().filter(function (x) { return x.name === ui.voiceSel.value; })[0];
      if (v) { u.voice = v; u.lang = v.lang; }
      u.rate = parseFloat(ui.rateSel.value) || 1;
      u.onend = function () { if (my === gen && playing) { idx++; speakCurrent(); } };
      u.onerror = function (e) {
        if (my !== gen || e.error === 'interrupted' || e.error === 'canceled') return;
        idx++; if (playing) speakCurrent();
      };
      synth.speak(u);
    }

    function play() {
      if (!book || !synth) return;
      playing = true;
      ui.playBtn.textContent = 'Pause';
      ui.playBtn.setAttribute('aria-pressed', 'true');
      speakCurrent();
      if (!play.tracked) { play.tracked = true; CV.track('read_aloud_start', { in_ext: key.split('.').pop().split('|')[0] }); }
    }

    function stop() {
      playing = false; gen++;
      if (synth) synth.cancel();
      ui.playBtn.textContent = 'Play';
      ui.playBtn.setAttribute('aria-pressed', 'false');
    }

    function jump(toIdx) {
      idx = Math.max(0, Math.min(sents.length - 1, toIdx));
      if (playing) speakCurrent(); else highlight();
    }

    ui.playBtn.addEventListener('click', function () { playing ? stop() : play(); });
    ui.prevBtn.addEventListener('click', function () { jump(idx - 1); });
    ui.nextBtn.addEventListener('click', function () { jump(idx + 1); });
    ui.chapterSel.addEventListener('change', function () {
      chapter = +ui.chapterSel.value; idx = 0; renderChapter();
      if (playing) speakCurrent(); else highlight();
    });
    // Voice/speed changes apply from the current sentence.
    [ui.voiceSel, ui.rateSel].forEach(function (el) {
      el.addEventListener('change', function () { if (playing) speakCurrent(); });
    });
    ui.text.addEventListener('click', function (e) {
      var s = e.target.closest && e.target.closest('.sent');
      if (s) jump(+s.dataset.i);
    });

    // Lock-screen / headset controls where supported.
    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.setActionHandler('play', play);
        navigator.mediaSession.setActionHandler('pause', stop);
        navigator.mediaSession.setActionHandler('nexttrack', function () { jump(idx + 1); });
        navigator.mediaSession.setActionHandler('previoustrack', function () { jump(idx - 1); });
      } catch (e) { /* older browsers */ }
    }

    return {
      supported: !!synth,
      open: function (b, bookKey) {
        stop();
        book = b; key = bookKey;
        ui.chapterSel.innerHTML = '';
        book.chapters.forEach(function (c, i) {
          var o = document.createElement('option');
          o.value = String(i);
          o.textContent = (i + 1) + '. ' + c.title.slice(0, 70);
          ui.chapterSel.appendChild(o);
        });
        fillVoices();
        var pos = loadPositions()[key];
        chapter = pos && pos.c < book.chapters.length ? pos.c : 0;
        renderChapter();
        idx = pos && pos.c === chapter && pos.s < sents.length ? pos.s : 0;
        highlight();
        if ('mediaSession' in navigator && global.MediaMetadata) {
          navigator.mediaSession.metadata = new MediaMetadata({ title: book.title, artist: book.author || '' });
        }
        return !!pos;
      },
      stop: stop
    };
  }

  global.ReadAloud = { Reader: Reader };
})(window);
