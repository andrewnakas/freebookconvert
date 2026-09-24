#!/usr/bin/env node
// Renders a 1200x630 social preview image per page into assets/og/<slug>.png,
// using each page's own <h1>. tools/sync.mjs then points og:image and
// twitter:image at it. Links shared in Slack, iMessage, Reddit, or X get a
// card that names the exact tool instead of one generic site image.
//
// Dev-time only, needs Playwright + a local Chrome (not a site dependency):
//   npx -y -p playwright@1 node tools/og.mjs            # all pages
//   npx -y -p playwright@1 node tools/og.mjs mp3-to-m4b # one page
//
// Re-run after adding a page or changing an <h1>, then run tools/sync.mjs.

import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'assets/og');
const only = process.argv[2];

// Resolve playwright from wherever npx put it.
const require = createRequire(join(process.cwd(), 'noop.js'));
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) {
  ({ chromium } = await import('playwright'));
}

const SKIP = new Set(['about', 'privacy', 'terms', 'contact']);
const CATEGORY = [
  [/audiobook|read-aloud|m4b|mp3/, 'Audiobooks', '#7c3aed'],
  [/heic|jpg|png|webp|image|cricut|sublimation|screenshot/, 'Images', '#0891b2'],
  [/ocr|searchable|text|recipe/, 'OCR', '#059669'],
  [/./, 'Ebooks & PDF', '#2563eb']
];

const decode = (s) => s.replace(/&amp;/g, '&').replace(/&rarr;/g, '→').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/<[^>]+>/g, '');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

function pages() {
  const out = [];
  // Homepage and guides index get their own cards.
  const home = [['index.html', 'home', 'Ebooks · PDF · Images · Audiobooks'], ['guides/index.html', 'guide-index', null]];
  for (const [file, slug, label] of home) {
    if (only && slug !== only) continue;
    const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(readFileSync(join(ROOT, file), 'utf8'));
    if (h1) out.push({ slug, title: slug === 'guide-index' ? 'Guides to ebook, PDF, image and audiobook formats' : decode(h1[1]).trim(), guide: slug === 'guide-index', label });
  }
  for (const dir of ['pages', 'guides']) {
    for (const f of readdirSync(join(ROOT, dir)).filter((f) => f.endsWith('.html') && f !== 'index.html').sort()) {
      const slug = (dir === 'guides' ? 'guide-' : '') + f.replace(/\.html$/, '');
      if (SKIP.has(slug) || (only && slug !== only)) continue;
      const src = readFileSync(join(ROOT, dir, f), 'utf8');
      const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(src);
      if (!h1) continue;
      out.push({ slug, title: decode(h1[1]).trim(), guide: dir === 'guides' });
    }
  }
  return out;
}

function html({ slug, title, guide, label: override }) {
  let [, label, color] = CATEGORY.find(([re]) => re.test(slug));
  if (override) { label = override; color = '#2563eb'; }
  const size = title.length > 34 ? 64 : 78;
  return `<html><body style="margin:0;width:1200px;height:630px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#fafbfc;display:flex;">
  <div style="width:24px;background:${color}"></div>
  <div style="flex:1;padding:72px 80px;display:flex;flex-direction:column;justify-content:space-between">
    <div style="font-size:28px;font-weight:600;color:${color};letter-spacing:.02em;text-transform:uppercase">${guide ? 'Guide' : esc(label)}</div>
    <div style="font-size:${size}px;font-weight:800;line-height:1.08;color:#111;letter-spacing:-.02em">${esc(title)}</div>
    <div style="display:flex;justify-content:space-between;align-items:flex-end">
      <div style="font-size:30px;color:#444">${guide ? 'Plain-English explainer' : 'Free · Nothing uploaded · Works offline'}</div>
      <div style="font-size:30px;font-weight:700;color:#111">FreeBookConvert</div>
    </div>
  </div></body></html>`;
}

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
let n = 0;
for (const p of pages()) {
  await page.setContent(html(p));
  await page.screenshot({ path: join(OUT, p.slug + '.png') });
  n++;
}
await browser.close();
console.log(`Rendered ${n} image(s) into assets/og/`);
