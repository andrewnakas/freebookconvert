#!/usr/bin/env node
// Tells Bing (and the other IndexNow engines: Yandex, Seznam, Naver) which URLs
// changed, so they recrawl in minutes instead of days. Google does not use
// IndexNow; it relies on sitemap.xml lastmod.
//
//   node tools/indexnow.mjs              pages changed in the last commit
//   node tools/indexnow.mjs HEAD~5       pages changed since HEAD~5
//   node tools/indexnow.mjs --all        every URL in sitemap.xml
//
// Run after the Cloudflare deploy finishes. If Cloudflare Crawler Hints is on,
// Cloudflare already pings IndexNow on cache changes; this is the manual path.

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOST = 'freebookconvert.com';
const KEY = 'ff1cc4369a9d61a167c71692c702977b'; // served at /<KEY>.txt

const sitemapUrls = [...readFileSync(join(ROOT, 'sitemap.xml'), 'utf8').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);

function changedUrls(since) {
  const files = execFileSync('git', ['diff', '--name-only', since, 'HEAD'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter((f) => f.endsWith('.html'));
  const paths = files.map((f) =>
    f === 'index.html' ? '/' : f.endsWith('/index.html') ? '/' + f.slice(0, -10) : '/' + f.replace(/\.html$/, ''));
  return sitemapUrls.filter((u) => paths.includes(new URL(u).pathname));
}

const arg = process.argv[2];
const urls = arg === '--all' ? sitemapUrls : changedUrls(arg || 'HEAD~1');
if (!urls.length) { console.log('No indexable pages changed.'); process.exit(0); }

const res = await fetch('https://api.indexnow.org/indexnow', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
  body: JSON.stringify({ host: HOST, key: KEY, keyLocation: `https://${HOST}/${KEY}.txt`, urlList: urls })
});
console.log(`IndexNow: HTTP ${res.status} for ${urls.length} URL(s)`);
urls.forEach((u) => console.log('  ' + u));
if (res.status >= 400) process.exit(1);
