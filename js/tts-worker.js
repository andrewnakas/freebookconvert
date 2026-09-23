/*
 * Neural text-to-speech worker (module worker, same origin).
 *
 * Runs Kokoro-82M through kokoro-js (transformers.js + onnxruntime-web) and
 * encodes the result to MP3 with LAME, so the page gets back small files
 * rather than hundreds of MB of raw PCM.
 *
 * Messages in:
 *   {type:'init'}
 *   {type:'speak', id, chunks:[string], voice, speed}   -> MP3 of all chunks
 *   {type:'cancel', id}
 * Messages out:
 *   {type:'load', progress:0..1, file}   {type:'ready', device}
 *   {type:'progress', id, done, total, seconds, elapsed}
 *   {type:'done', id, mp3:Uint8Array, seconds}   {type:'error', id?, message}
 */
// Loaded with dynamic import(): Chrome checks a module worker's *static*
// imports against the page's worker-src, which is (rightly) 'self' blob: only.
const KOKORO = 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js';
const LAME = 'https://cdn.jsdelivr.net/npm/@breezystack/lamejs@1.2.7/dist/lamejs.js';
let KokoroTTS, Mp3Encoder;

const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const RATE = 24000;           // Kokoro's output sample rate
const KBPS = 64;              // mono speech: 64 kbps ~ 29 MB per hour
const GAP = new Int16Array(Math.round(RATE * 0.12)); // breath between chunks

let tts = null;
let device = null;
const cancelled = new Set();

function toInt16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

// CPU (WASM) only, deliberately. Tested 2026-09 with kokoro-js 1.2.1 in Chrome:
// WebGPU fp32 (325 MB) failed to download, fp16 crashed the tab, and q4f16
// produced unintelligible audio. q8 on WASM is correct everywhere. Revisit
// WebGPU when kokoro-js/transformers.js update, and verify output by
// transcription, not by ear or loudness.
async function init() {
  if (tts) return;
  [{ KokoroTTS }, { Mp3Encoder }] = await Promise.all([import(KOKORO), import(LAME)]);
  device = 'wasm';
  const dtype = 'q8';
  const seen = {};
  tts = await KokoroTTS.from_pretrained(MODEL, {
    dtype,
    device,
    progress_callback: (p) => {
      if (p.status !== 'progress' || !p.total) return;
      seen[p.file] = [p.loaded, p.total];
      let loaded = 0, total = 0;
      for (const k in seen) { loaded += seen[k][0]; total += seen[k][1]; }
      postMessage({ type: 'load', progress: loaded / total, file: p.file });
    }
  });
}

async function speak({ id, chunks, voice, speed }) {
  const enc = new Mp3Encoder(1, RATE, KBPS);
  const parts = [];
  let samples = 0;
  const started = performance.now();
  for (let i = 0; i < chunks.length; i++) {
    if (cancelled.has(id)) { cancelled.delete(id); postMessage({ type: 'cancelled', id }); return; }
    const audio = await tts.generate(chunks[i], { voice, speed });
    const pcm = toInt16(audio.audio);
    samples += pcm.length + GAP.length;
    // lamejs wants blocks that are multiples of 1152 samples for best results,
    // but handles any length; encode chunk + gap directly.
    let buf = enc.encodeBuffer(pcm);
    if (buf.length) parts.push(new Uint8Array(buf));
    buf = enc.encodeBuffer(GAP);
    if (buf.length) parts.push(new Uint8Array(buf));
    postMessage({
      type: 'progress', id, done: i + 1, total: chunks.length,
      seconds: samples / RATE, elapsed: (performance.now() - started) / 1000
    });
  }
  const tail = enc.flush();
  if (tail.length) parts.push(new Uint8Array(tail));
  let len = 0;
  for (const p of parts) len += p.length;
  const mp3 = new Uint8Array(len);
  let off = 0;
  for (const p of parts) { mp3.set(p, off); off += p.length; }
  postMessage({ type: 'done', id, mp3, seconds: samples / RATE }, [mp3.buffer]);
}

// One job at a time: the model isn't re-entrant and the CPU is saturated
// anyway. Messages queue here in order.
let queue = Promise.resolve();

self.onmessage = (e) => {
  const msg = e.data || {};
  if (msg.type === 'cancel') { cancelled.add(msg.id); return; }
  queue = queue.then(async () => {
    try {
      if (msg.type === 'init') {
        await init();
        postMessage({ type: 'ready', device });
      } else if (msg.type === 'speak') {
        if (!tts) throw new Error('Voice model not loaded.');
        await speak(msg);
      }
    } catch (err) {
      postMessage({ type: 'error', id: msg.id, message: String((err && err.message) || err) });
    }
  });
};
