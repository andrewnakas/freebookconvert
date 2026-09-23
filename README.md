# FreeBookConvert

**Free file converters that never upload your files.** Live at
**[freebookconvert.com](https://freebookconvert.com)**.

Every conversion runs inside your browser tab with JavaScript and WebAssembly.
There is no backend: the site is plain static files, and your files never touch
a server. You can check this yourself: load a page, turn off Wi-Fi, and convert.

## What it does

| Category | Tools |
|---|---|
| Ebooks | EPUB → PDF, PDF → EPUB (with chapter detection), EPUB → TXT, CBZ → PDF, images → CBZ, PDFs tuned for Kindle Scribe / Kobo / Boox / reMarkable |
| PDF | Merge PDF, PDF → JPG/PNG, images → PDF, OCR / searchable PDF, scanned PDF → text |
| Images | HEIC → JPG/PNG/PDF, JPG ⇄ PNG ⇄ WEBP, image → text (OCR) |
| Audiobooks | EPUB/PDF → audiobook (on-device AI narration), Read Aloud, MP3 → M4B with chapters, M4B → MP3 split by chapter |

It's also an installable PWA that works offline and can open files from the OS
"Open with" menu.

## How it works

| Tool | Libraries |
|---|---|
| EPUB ⇄ PDF, CBZ, merge | [JSZip](https://stuk.github.io/jszip/), [pdf-lib](https://pdf-lib.js.org/) |
| PDF rendering and text | [pdf.js](https://mozilla.github.io/pdf.js/) |
| HEIC | [heic-to](https://github.com/hoppergee/heic-to) (libheif) |
| OCR | [Tesseract.js](https://tesseract.projectnaptha.com/) |
| M4B / MP3 | [ffmpeg.wasm](https://ffmpegwasm.netlify.app/) core, single-thread |
| Neural narration | [kokoro-js](https://github.com/hexgrad/kokoro) (Kokoro-82M, Apache 2.0) via transformers.js, MP3 via [lamejs](https://github.com/zhuker/lamejs) |
| Read Aloud | Web Speech API |

Libraries are loaded from pinned CDN versions only when a conversion starts, and
checked against SRI or SHA-384 hashes where the browser allows it.

## Run it locally

No build step and no dependencies:

```sh
git clone https://github.com/andrewnakas/freebookconvert.git
cd freebookconvert
python3 -m http.server 8080    # then open http://localhost:8080/pages/epub-to-pdf.html
```

Use `http://`, not `file://`: module workers and pdf.js need a real origin.
Pretty URLs like `/epub-to-pdf` come from `_redirects` (Cloudflare Pages), so
locally use the `/pages/*.html` paths.

## Project layout

```
index.html, 404.html   homepage (with the universal drop zone) and error page
pages/                 one HTML page per converter, plus about/privacy/terms
guides/                long-form explainers
js/common.js           shared dropzone, status, download, analytics hooks, "what next" suggestions
js/*.js                one module per converter; audio in audio-core.js, m4b.js, tts-worker.js
tools/sync.mjs         rewrites shared blocks + generates sitemap.xml and llms.txt
tools/partials/        the shared CSP, analytics, header, footer, PWA blocks
sw.js, manifest.webmanifest, js/pwa.js   installable app / offline support
```

### Shared blocks and the sitemap

The CSP, analytics/consent, header, and footer are the same on every page and
live in `tools/partials/`. Each page holds a copy between marker comments
(`<!-- @header -->` … `<!-- /@header -->`). To change one site-wide:

```sh
# edit tools/partials/<block>.html, then
node tools/sync.mjs          # rewrites every page, regenerates sitemap.xml and llms.txt
node tools/sync.mjs --check  # exits 1 if anything is out of date
```

`sitemap.xml` is generated from every page without `noindex`, with `lastmod`
taken from the last git commit that touched the file. To add a page: create the
HTML file (copy an existing one), run sync, and add a short URL to `_redirects`.

### Audio architecture

- **ffmpeg** (`js/audio-core.js`, `js/ffmpeg-worker.js`): the core JS and wasm
  are fetched from jsDelivr, checked against pinned SHA-384 hashes, and handed
  to a same-origin worker as blob URLs. The @ffmpeg/ffmpeg wrapper can't be used
  because it spawns a cross-origin worker. It's single-thread on purpose, since
  multi-thread needs COOP/COEP headers, which break third-party iframes.
- **TTS** (`js/tts-worker.js`): a module worker that loads kokoro-js and lamejs
  with dynamic `import()`. Static imports in a module worker are checked against
  the page's `worker-src` (`'self' blob:`) and fail.
- **CPU only, deliberately.** Tested 2026-09 with kokoro-js 1.2.1: WebGPU fp32
  wouldn't download, fp16 crashed the tab, and q4f16 produced unintelligible
  audio (checked by Whisper transcription). WASM q8 is correct. Please don't
  re-enable WebGPU without transcribing the output.
- Finished TTS chapters persist in IndexedDB (`fbc_tts`, 30-day expiry), and Read
  Aloud positions in localStorage. Both are documented in the privacy policy.

### Other tools

```sh
node tools/indexnow.mjs                     # tell Bing/IndexNow about pages changed in the last commit
npx -y -p playwright@1 node tools/og.mjs    # re-render assets/og/*.png social cards (needs local Chrome)
```

## Forking and self-hosting

The code is MIT licensed, so fork away. If you deploy your own copy:

- **Replace the IDs in `tools/partials/`** (the Google Analytics measurement ID,
  AdSense client ID, and Clarity ID), remove the IndexNow key file, and run
  `node tools/sync.mjs`. Otherwise your traffic is reported into this site's
  accounts.
- Replace `freebookconvert.com` in `tools/sync.mjs` (`ORIGIN`),
  `tools/indexnow.mjs`, `robots.txt`, and the canonical/OG tags.
- Please use your own name and logo. The license covers the code, not the
  FreeBookConvert name or branding.

## Contributing

Issues and pull requests are welcome, especially:

- Files that fail to convert (attach a sample if you can share it, or describe its origin).
- New converters that can run fully in the browser.
- Accessibility and mobile fixes.

Keep the one rule: **nothing may upload user files.** A change that needs a
server for conversion won't be merged.

## License

[MIT](LICENSE). Third-party libraries keep their own licenses and are loaded
from their CDNs at runtime. The ffmpeg.wasm core is built with GPL components,
and the Kokoro model is Apache 2.0.
