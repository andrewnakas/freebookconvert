# FreeBookConvert

A static, browser-only file converter site. All conversions happen client-side
via JavaScript and WebAssembly — there is no server-side processing, so hosting
costs are limited to static-file serving (e.g. Cloudflare Pages, GitHub Pages,
Netlify, S3 + CloudFront). Revenue model: Google AdSense.

## Converters shipped

| Path                          | What it does                                  | Libraries used               |
|-------------------------------|-----------------------------------------------|------------------------------|
| `pages/epub-to-pdf.html`      | EPUB → PDF (text-selectable)                  | JSZip, pdf-lib               |
| `pages/pdf-to-epub.html`      | PDF → EPUB (reflowable, with chapter detect)  | pdf.js (ESM), JSZip          |
| `pages/cbz-to-pdf.html`       | CBZ (or ZIP of images) → PDF                  | JSZip, pdf-lib               |
| `pages/epub-to-txt.html`      | EPUB → plain text                             | JSZip                        |
| `pages/heic-to-pdf.html`      | HEIC/JPG/PNG → single combined PDF            | heic-to (libheif), pdf-lib   |

## Why these formats?

Research showed each of these has high search volume and weak client-side
competition — almost every existing online converter for these is server-side.
That's the differentiator: privacy (files never leave the browser) plus no
upload waits and no size caps.

Formats that already have strong browser-only competition were intentionally
skipped (HEIC→JPG, EPUB→TXT-as-single-feature, GPX/KML, SRT/VTT, vCard/CSV,
SVG→ICO, etc.).

## Deployment

This is a fully static site. To deploy:

1. Replace the ad slot placeholders (`<!-- AdSense -->`) with your real AdSense
   `<ins>` tags and uncomment the loader script in `index.html`.
2. Replace `freebookconvert.com` with your actual domain in:
   - All `<link rel="canonical">` tags
   - `<meta property="og:*">` tags
   - `robots.txt`
   - `sitemap.xml`
3. Upload the entire `ebook-converter/` directory contents to your static host.

## Shared blocks and the sitemap

The CSP, analytics/consent, header, and footer are identical on every page and
live in `tools/partials/`. Each page holds a copy between marker comments
(`<!-- @header -->` … `<!-- /@header -->`). To change one site-wide:

```sh
# edit tools/partials/<block>.html, then
node tools/sync.mjs          # rewrites every page + regenerates sitemap.xml
node tools/sync.mjs --check  # exits 1 if anything is out of date
```

`sitemap.xml` is generated: every page without `noindex`, with `lastmod` from
the last git commit touching the file. Commit page edits *before* running sync
if you want their `lastmod` to move. Adding a page = create the HTML file, run
sync, add a short URL to `_redirects`.

## Local preview

```sh
cd ebook-converter
python3 -m http.server 8080
# then open http://localhost:8080
```

(Plain `file://` mostly works too, but the pdf.js page needs `http://` because
its worker is loaded as an ES module from a CDN with CORS restrictions.)

## Monetization next steps

1. Apply for AdSense once the site has a few weeks of traffic. (AdSense rejects
   brand-new no-traffic sites.)
2. Add a Buy Me a Coffee / Stripe link as a soft monetization layer.
3. SEO: build backlinks by sharing on r/ebooks, r/Calibre, r/comicbooks,
   r/iPhone (HEIC pain).
4. Add converter pages for: WEBP→PDF, JPG→PDF (high-volume, easy adds with
   existing code).
