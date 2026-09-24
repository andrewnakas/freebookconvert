#!/usr/bin/env node
// Rewrites the blocks every page shares (CSP, analytics, header, footer) from
// tools/partials/ and regenerates sitemap.xml. Zero dependencies.
//
//   node tools/sync.mjs          write changes
//   node tools/sync.mjs --check  exit 1 if anything is out of date (for CI)
//
// Each shared block sits between marker comments, e.g.
//   <!-- @header -->…<!-- /@header -->
// Pages that predate the markers are migrated on first run: the legacy block is
// found by pattern and replaced with the marked version.

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://freebookconvert.com';
const CHECK = process.argv.includes('--check');

const partial = (name) => readFileSync(join(ROOT, 'tools/partials', name + '.html'), 'utf8').trimEnd();

function listPages() {
  const html = (dir) => readdirSync(join(ROOT, dir))
    .filter((f) => f.endsWith('.html'))
    .sort()
    .map((f) => (dir === '.' ? f : dir + '/' + f));
  return [...html('.'), ...html('pages'), ...html('guides')];
}

// '/pages/epub-to-pdf', '/guides/', '/'
function urlPath(file) {
  if (file === 'index.html') return '/';
  if (file.endsWith('/index.html')) return '/' + file.slice(0, -'index.html'.length);
  return '/' + file.replace(/\.html$/, '');
}

const isNoindex = (src) => /<meta name="robots" content="noindex/i.test(src);

// ---------- block definitions ------------------------------------------------
// legacy: regexes removed on migration (the first match marks where the block
// goes). anchor: fallback insertion point when no legacy block exists.

const BLOCKS = [
  {
    name: 'csp',
    render: () => partial('csp'),
    legacy: [/<meta http-equiv="Content-Security-Policy"[^>]*>\n/],
    anchor: { re: /<meta name="viewport"[^>]*>\n/, after: true }
  },
  {
    name: 'pwa',
    render: () => partial('pwa'),
    legacy: [],
    anchor: { re: /<!-- @analytics -->/, after: false }
  },
  {
    name: 'analytics',
    // No ads on noindex pages (404): AdSense disallows ads on pages without
    // publisher content.
    render: (ctx) => (ctx.noindex ? '' : partial('adsense') + '\n') + partial('analytics'),
    legacy: [
      /<!-- Google tag \(gtag\.js\) -->\n/,
      /<script async src="https:\/\/www\.googletagmanager\.com\/gtag\/js[^"]*"><\/script>\n<script>[\s\S]*?gtag\('config'[^\n]*\n<\/script>\n/,
      /<script async src="https:\/\/pagead2\.googlesyndication\.com\/pagead\/js\/adsbygoogle\.js[^"]*" crossorigin="anonymous"><\/script>\n/
    ],
    anchor: { re: /<\/head>/, after: false }
  },
  {
    name: 'header',
    render: (ctx) => markCurrent(partial('header'), ctx.path),
    legacy: [/<header class="site-header">[\s\S]*?<\/header>\n/],
    anchor: { re: /<body[^>]*>\n/, after: true }
  },
  {
    name: 'footer',
    render: () => partial('footer'),
    legacy: [/<footer class="site-footer">[\s\S]*?<\/footer>\n/],
    anchor: { re: /<script /, after: false }
  }
];

function markCurrent(html, path) {
  return html.replace(/<a href="([^"]+)">/g, (m, href) =>
    href === path ? `<a href="${href}" aria-current="page">` : m);
}

function applyBlock(src, block, ctx, file) {
  const open = `<!-- @${block.name} -->`;
  const close = `<!-- /@${block.name} -->`;
  const body = block.render(ctx);
  const wrapped = `${open}\n${body ? body + '\n' : ''}${close}\n`;

  const start = src.indexOf(open);
  if (start !== -1) {
    const end = src.indexOf(close, start);
    if (end === -1) throw new Error(`${file}: ${open} has no closing ${close}`);
    let after = end + close.length;
    if (src[after] === '\n') after++;
    return src.slice(0, start) + wrapped + src.slice(after);
  }

  // Migration: strip every legacy fragment, remembering where the first was.
  let at = -1;
  for (const re of block.legacy) {
    const m = re.exec(src);
    if (!m) continue;
    if (at === -1 || m.index < at) at = m.index;
    src = src.slice(0, m.index) + src.slice(m.index + m[0].length);
  }
  if (at === -1) {
    const m = block.anchor.re.exec(src);
    if (!m) throw new Error(`${file}: no place to insert @${block.name}`);
    at = block.anchor.after ? m.index + m[0].length : m.index;
  }
  return src.slice(0, at) + wrapped + src.slice(at);
}

// ---------- per-page social images -------------------------------------------
// tools/og.mjs renders assets/og/<slug>.png. When one exists, point og:image
// and twitter:image at it. The ?v= content hash busts the year-long immutable
// cache on /assets/* whenever the image is re-rendered.

function applyOgImage(src, file) {
  let slug;
  if (file === 'index.html') slug = 'home';
  else if (file === 'guides/index.html') slug = 'guide-index';
  else {
    const m = /^(pages|guides)\/(.+)\.html$/.exec(file);
    if (!m) return src;
    slug = (m[1] === 'guides' ? 'guide-' : '') + m[2];
  }
  let bytes;
  try { bytes = readFileSync(join(ROOT, 'assets/og', slug + '.png')); } catch (e) { return src; }
  const v = createHash('sha1').update(bytes).digest('hex').slice(0, 8);
  const url = `${ORIGIN}/assets/og/${slug}.png?v=${v}`;
  return src.replace(/(<meta (?:property="og:image"|name="twitter:image") content=")[^"]*(")/g, `$1${url}$2`);
}

// ---------- pages ------------------------------------------------------------

const pages = listPages();
const stale = [];

for (const file of pages) {
  const abs = join(ROOT, file);
  const before = readFileSync(abs, 'utf8');
  const ctx = { path: urlPath(file), noindex: isNoindex(before) };
  let src = before;
  for (const block of BLOCKS) src = applyBlock(src, block, ctx, file);
  src = applyOgImage(src, file);
  if (src !== before) {
    stale.push(file);
    if (!CHECK) writeFileSync(abs, src);
  }
}

// ---------- sitemap ----------------------------------------------------------
// Only indexable pages. lastmod comes from the last commit that touched the
// file, so it moves only when the page really changed (Bing weighs it; Google
// uses it when it is consistently accurate). Uncommitted files get today.

function lastmod(file) {
  try {
    const d = execFileSync('git', ['log', '-1', '--format=%cs', '--', file], { cwd: ROOT, encoding: 'utf8' }).trim();
    if (d) return d;
  } catch (e) { /* not a git checkout */ }
  return new Date().toISOString().slice(0, 10);
}

const indexable = pages.filter((f) => !isNoindex(readFileSync(join(ROOT, f), 'utf8')));
const sitemap =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<!-- Generated by tools/sync.mjs; do not edit by hand. -->\n' +
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
  indexable.map((f) => `  <url><loc>${ORIGIN}${urlPath(f)}</loc><lastmod>${lastmod(f)}</lastmod></url>\n`).join('') +
  '</urlset>\n';

const sitemapPath = join(ROOT, 'sitemap.xml');
if (readFileSync(sitemapPath, 'utf8') !== sitemap) {
  stale.push('sitemap.xml');
  if (!CHECK) writeFileSync(sitemapPath, sitemap);
}

// ---------- llms.txt ---------------------------------------------------------
// A plain-text map of the site for AI answer engines (llmstxt.org). Built from
// each page's <title> and meta description so it never drifts from the pages.

function meta(file) {
  const src = readFileSync(join(ROOT, file), 'utf8');
  const title = (/<title>([^<]*)<\/title>/.exec(src) || [])[1] || file;
  const desc = (/<meta name="description" content="([^"]*)"/.exec(src) || [])[1] || '';
  const clean = (s) => s.replace(/\s*[|—]\s*FreeBookConvert$/, '').replace(/&amp;/g, '&').replace(/&rarr;/g, '→').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"');
  return { title: clean(title), desc: clean(desc) };
}

const section = (heading, files) => files.length
  ? `## ${heading}\n\n` + files.map((f) => {
      const m = meta(f);
      return `- [${m.title}](${ORIGIN}${urlPath(f)})${m.desc ? ': ' + m.desc : ''}`;
    }).join('\n') + '\n\n'
  : '';

const LEGAL = ['pages/about.html', 'pages/privacy.html', 'pages/terms.html', 'pages/contact.html'];
const llms =
  '# FreeBookConvert\n\n' +
  '> Free file converters for ebooks, PDFs, images, and audiobooks that run entirely in the browser. ' +
  'Files are never uploaded: conversion happens locally with JavaScript and WebAssembly, and works offline once the page has loaded. ' +
  'No signup, no watermark, no file size limit beyond device memory.\n\n' +
  section('Converters', indexable.filter((f) => f.startsWith('pages/') && !LEGAL.includes(f))) +
  section('Guides', indexable.filter((f) => f.startsWith('guides/'))) +
  section('About', indexable.filter((f) => LEGAL.includes(f)));

const llmsPath = join(ROOT, 'llms.txt');
let llmsBefore = '';
try { llmsBefore = readFileSync(llmsPath, 'utf8'); } catch (e) { /* first run */ }
if (llmsBefore !== llms.trimEnd() + '\n') {
  stale.push('llms.txt');
  if (!CHECK) writeFileSync(llmsPath, llms.trimEnd() + '\n');
}

if (CHECK && stale.length) {
  console.error('Out of date (run node tools/sync.mjs):\n  ' + stale.join('\n  '));
  process.exit(1);
}
console.log(stale.length ? `${CHECK ? 'Stale' : 'Updated'} ${stale.length} file(s): ${stale.join(', ')}` : 'Everything up to date.');
console.log(`${pages.length} pages, ${indexable.length} in sitemap.`);
