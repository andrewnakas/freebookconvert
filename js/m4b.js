/*
 * Audiobook containers:
 *   Mp3ToM4b.convert  several audio files -> one M4B, one chapter per file
 *   M4bToMp3.convert  one M4B/M4A -> MP3 (or M4A) per chapter, zipped
 *
 * Both run ffmpeg.wasm through AudioCore (js/audio-core.js).
 */
(function (global) {
  var A = global.AudioCore;

  var QUALITY = {
    voice: ['-c:a', 'aac', '-b:a', '64k', '-ac', '1'],
    music: ['-c:a', 'aac', '-b:a', '128k', '-ac', '2']
  };

  // "01 - The Beginning" -> "The Beginning"; "track03" stays "track03".
  function chapterTitle(fileName, i) {
    var t = A.baseName(fileName).replace(/[_]+/g, ' ').trim();
    var stripped = t.replace(/^\s*(?:disc\s*\d+\s*[-_. ]\s*)?\d{1,3}\s*[-_.)]\s*/i, '').trim();
    return stripped || t || 'Chapter ' + (i + 1);
  }

  function extOf(name) {
    var m = /\.([a-z0-9]+)$/i.exec(name);
    return m ? m[1].toLowerCase() : 'bin';
  }

  function progressReporter(total, from, to, label, onProgress) {
    return function (line) {
      var t = A.progressTime(line);
      if (t == null || !total) return;
      var f = Math.min(1, t / total);
      onProgress(from + f * (to - from), label + ' ' + A.fmtDuration(t) + ' / ' + A.fmtDuration(total));
    };
  }

  function engineProgress(onProgress, to) {
    return function (f) { onProgress(Math.round(f * to), 'Downloading the audio engine (31 MB, one time)… ' + Math.round(f * 100) + '%'); };
  }

  // ---------- MP3s -> M4B -----------------------------------------------------

  // files: File[] in playback order. opts: {title, author, cover: File|null,
  // quality: 'voice'|'music', titles: string[] (optional per-file chapter names)}
  async function toM4b(files, opts, onProgress) {
    opts = opts || {};
    onProgress = onProgress || function () {};
    var ff = await A.ffmpeg(engineProgress(onProgress, 15));
    var inputs = [];
    try {
      onProgress(16, 'Reading your files…');
      for (var i = 0; i < files.length; i++) {
        var name = 'in' + i + '.' + extOf(files[i].name);
        await ff.writeFile(name, files[i]);
        inputs.push(name);
      }

      // Pass 1: no output file, so ffmpeg just prints each input's duration
      // and exits with an error we ignore.
      var probeArgs = ['-hide_banner'];
      inputs.forEach(function (n) { probeArgs.push('-i', n); });
      var probe = await ff.exec(probeArgs);
      var durations = A.inputDurations(probe.log);
      for (i = 0; i < files.length; i++) {
        if (!(durations[i] > 0)) throw new Error('Could not read "' + files[i].name + '". Is it a valid audio file?');
      }

      var chapters = [], t = 0;
      files.forEach(function (f, idx) {
        var title = (opts.titles && opts.titles[idx]) || chapterTitle(f.name, idx);
        chapters.push({ title: title, start: t, end: t + durations[idx] });
        t += durations[idx];
      });
      var total = t;
      var bookTitle = opts.title || chapterTitle(files[0].name, 0);
      await ff.writeFile('meta.txt', A.buildFfmetadata({
        title: bookTitle, album: bookTitle, artist: opts.author, album_artist: opts.author, genre: 'Audiobook'
      }, chapters));

      var args = ['-hide_banner'];
      inputs.forEach(function (n) { args.push('-i', n); });
      var metaIdx = inputs.length;
      args.push('-i', 'meta.txt');
      var coverIdx = -1;
      if (opts.cover) {
        await ff.writeFile('cover.' + extOf(opts.cover.name), opts.cover);
        coverIdx = metaIdx + 1;
        args.push('-i', 'cover.' + extOf(opts.cover.name));
      }

      if (inputs.length === 1) {
        args.push('-map', '0:a:0');
      } else {
        // Normalise each input first: the concat filter needs every segment to
        // share sample rate and channel layout, and real-world folders mix them.
        var f = '';
        inputs.forEach(function (_, k) {
          f += '[' + k + ':a:0]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a' + k + '];';
        });
        inputs.forEach(function (_, k) { f += '[a' + k + ']'; });
        f += 'concat=n=' + inputs.length + ':v=0:a=1[out]';
        args.push('-filter_complex', f, '-map', '[out]');
      }
      args.push('-map_metadata', String(metaIdx), '-map_chapters', String(metaIdx));
      if (coverIdx >= 0) args.push('-map', coverIdx + ':v:0', '-c:v', 'copy', '-disposition:v:0', 'attached_pic');
      args = args.concat(QUALITY[opts.quality] || QUALITY.voice);
      args.push('-brand', 'M4B ', '-f', 'mp4', 'out.m4b');

      onProgress(20, 'Encoding…');
      var run = await ff.exec(args, progressReporter(total, 20, 97, 'Encoding', onProgress));
      if (run.code !== 0) throw new Error('Encoding failed:\n' + A.lastLines(run.log));

      onProgress(98, 'Saving…');
      var bytes = await ff.readFile('out.m4b');
      return {
        blob: new Blob([bytes], { type: 'audio/mp4' }),
        filename: A.safeName(bookTitle) + '.m4b',
        chapters: chapters,
        duration: total
      };
    } finally {
      inputs.concat(['meta.txt', 'out.m4b']).forEach(function (n) { ff.deleteFile(n); });
      if (opts.cover) ff.deleteFile('cover.' + extOf(opts.cover.name));
    }
  }

  // ---------- M4B -> MP3 per chapter -----------------------------------------

  // Reads chapter list + tags without converting anything.
  async function readChapters(ff, inName) {
    var run = await ff.exec(['-hide_banner', '-i', inName, '-f', 'ffmetadata', '-y', 'meta.txt']);
    var duration = A.inputDurations(run.log)[0] || 0;
    if (run.code !== 0 && !duration) throw new Error('Could not read this file:\n' + A.lastLines(run.log));
    var text = new TextDecoder().decode(await ff.readFile('meta.txt'));
    ff.deleteFile('meta.txt');
    var meta = A.parseFfmetadata(text);
    var hasCover = run.log.some(function (l) { return /Stream #0:\d+.*Video:.*(attached pic|mjpeg|png)/i.test(l); });
    return { tags: meta.tags, chapters: meta.chapters, duration: duration, hasCover: hasCover };
  }

  // opts: {mode: 'mp3' | 'm4a' | 'single', quality: 'voice'|'music'}
  async function fromM4b(file, opts, onProgress) {
    opts = opts || {};
    onProgress = onProgress || function () {};
    if (/\.aax$/i.test(file.name)) {
      throw new Error('AAX files from Audible are DRM-protected and can’t be converted here.');
    }
    var ff = await A.ffmpeg(engineProgress(onProgress, 15));
    var inName = 'in.' + extOf(file.name);
    var made = [];
    try {
      onProgress(16, 'Reading the audiobook…');
      await ff.writeFile(inName, file);
      var info = await readChapters(ff, inName);
      var book = info.tags.album || info.tags.title || A.baseName(file.name);
      var author = info.tags.artist || info.tags.album_artist || '';
      var mp3Q = opts.quality === 'music' ? ['-b:a', '128k', '-ac', '2'] : ['-b:a', '64k', '-ac', '1'];

      if (opts.mode === 'single' || !info.chapters.length) {
        var args = ['-hide_banner', '-i', inName, '-map', '0:a:0', '-map_metadata', '0', '-map_chapters', '0',
          '-c:a', 'libmp3lame'].concat(mp3Q, ['-id3v2_version', '3', '-f', 'mp3', 'out.mp3']);
        made.push('out.mp3');
        var r = await ff.exec(args, progressReporter(info.duration, 18, 97, 'Converting', onProgress));
        if (r.code !== 0) throw new Error('Conversion failed:\n' + A.lastLines(r.log));
        var one = await ff.readFile('out.mp3');
        return {
          blob: new Blob([one], { type: 'audio/mpeg' }),
          filename: A.safeName(book) + '.mp3',
          chapters: info.chapters.length
        };
      }

      await CV.load('jszip');
      var zip = new JSZip();
      var n = info.chapters.length;
      var pad = String(n).length < 2 ? 2 : String(n).length;
      var copy = opts.mode === 'm4a';
      var ext = copy ? 'm4a' : 'mp3';

      for (var i = 0; i < n; i++) {
        var c = info.chapters[i];
        var len = Math.max(0.1, c.end - c.start);
        var num = String(i + 1).padStart(pad, '0');
        var out = 'ch' + num + '.' + ext;
        var from = 18 + (c.start / info.duration) * 79;
        var to = 18 + (c.end / info.duration) * 79;
        var label = 'Chapter ' + (i + 1) + ' of ' + n + ':';
        var a = ['-hide_banner', '-ss', c.start.toFixed(3), '-i', inName, '-t', len.toFixed(3), '-map', '0:a:0',
          '-map_metadata', '-1', '-map_chapters', '-1',
          '-metadata', 'title=' + c.title, '-metadata', 'album=' + book, '-metadata', 'track=' + (i + 1) + '/' + n];
        if (author) a.push('-metadata', 'artist=' + author);
        if (copy) a.push('-c', 'copy', '-f', 'mp4', out);
        else a = a.concat(['-c:a', 'libmp3lame'], mp3Q, ['-id3v2_version', '3', '-f', 'mp3', out]);
        made.push(out);
        onProgress(from, label + ' ' + c.title);
        var res = await ff.exec(a, function (line) {
          var t = A.progressTime(line);
          if (t != null) onProgress(from + Math.min(1, t / len) * (to - from), label + ' ' + c.title);
        });
        if (res.code !== 0) throw new Error('Chapter ' + (i + 1) + ' failed:\n' + A.lastLines(res.log));
        zip.file(num + ' - ' + A.safeName(c.title, 60) + '.' + ext, await ff.readFile(out), { compression: 'STORE' });
        ff.deleteFile(out);
      }

      onProgress(98, 'Zipping ' + n + ' files…');
      var blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
      return { blob: blob, filename: A.safeName(book) + ' (' + n + ' chapters).zip', chapters: n };
    } finally {
      [inName].concat(made).forEach(function (f) { ff.deleteFile(f); });
    }
  }

  // Page helper: chapter list for preview before converting.
  async function inspect(file, onProgress) {
    var ff = await A.ffmpeg(engineProgress(onProgress || function () {}, 90));
    var inName = 'peek.' + extOf(file.name);
    try {
      await ff.writeFile(inName, file);
      return await readChapters(ff, inName);
    } finally {
      ff.deleteFile(inName);
    }
  }

  global.Mp3ToM4b = { convert: toM4b, chapterTitle: chapterTitle };
  global.M4bToMp3 = { convert: fromM4b, inspect: inspect };
})(window);
