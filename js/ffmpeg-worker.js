/*
 * ffmpeg.wasm host worker (classic worker, same origin).
 *
 * @ffmpeg/ffmpeg's own wrapper spawns its worker from a CDN URL, which browsers
 * refuse (workers must be same-origin), and its module-worker fallback can't
 * importScripts the UMD core. So this file speaks to @ffmpeg/core directly.
 * AudioCore (js/audio-core.js) fetches and hash-checks the core JS and wasm,
 * then passes them in as blob: URLs.
 *
 * Protocol: {id, type, data} in -> {id, type, data} out, plus unsolicited
 * {type: 'LOG', data: string} messages while a command runs.
 */
/* global createFFmpegCore */
var core = null;

self.onmessage = async function (e) {
  var msg = e.data || {};
  var id = msg.id, type = msg.type, data = msg.data || {};
  try {
    var result, transfer = [];
    switch (type) {
      case 'LOAD':
        if (!core) {
          importScripts(data.coreURL);
          // The core reads its wasm location from the hash of this URL.
          core = await createFFmpegCore({
            mainScriptUrlOrBlob: data.coreURL + '#' + btoa(JSON.stringify({ wasmURL: data.wasmURL }))
          });
          core.setLogger(function (l) { self.postMessage({ type: 'LOG', data: l.message }); });
        }
        result = true;
        break;
      case 'EXEC':
        core.setTimeout(-1);
        core.exec.apply(core, data.args);
        result = core.ret;
        core.reset();
        break;
      case 'WRITE_FILE':
        core.FS.writeFile(data.path, data.data);
        result = true;
        break;
      case 'READ_FILE':
        result = core.FS.readFile(data.path);
        transfer.push(result.buffer);
        break;
      case 'DELETE_FILE':
        try { core.FS.unlink(data.path); } catch (err) { /* already gone */ }
        result = true;
        break;
      default:
        throw new Error('Unknown message: ' + type);
    }
    self.postMessage({ id: id, type: type, data: result }, transfer);
  } catch (err) {
    self.postMessage({ id: id, type: 'ERROR', data: String(err && err.message || err) });
  }
};
