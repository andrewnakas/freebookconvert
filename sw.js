/*
 * Service worker: makes the converters work offline and load instantly on
 * repeat visits. Files being converted never touch it: they never leave the
 * page, and this only caches the site's own code plus pinned CDN libraries.
 *
 *   HTML            network first, cached copy when offline
 *   /css /js /assets stale-while-revalidate
 *   pinned CDN libs cache first (URLs contain exact versions, so they never change)
 *
 * Ads and analytics are never intercepted.
 */
const VERSION = 'v2';
const PAGES = 'fbc-pages-' + VERSION;
const STATIC = 'fbc-static-' + VERSION;
const LIBS = 'fbc-libs-v1';   // versioned URLs: safe to keep across releases
const LIB_HOSTS = ['cdn.jsdelivr.net', 'unpkg.com', 'cdnjs.cloudflare.com'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(STATIC).then((c) => c.addAll(['/', '/css/style.css', '/js/common.js', '/js/universal-entry.js?v=report1', '/js/consent.js'])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  const keep = [PAGES, STATIC, LIBS];
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('fbc-') && !keep.includes(k)).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

async function networkFirst(req) {
  const cache = await caches.open(PAGES);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    return (await cache.match(req, { ignoreSearch: true })) || (await caches.match('/')) || Response.error();
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(STATIC);
  const hit = await cache.match(req);
  const fresh = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => hit);
  return hit || fresh;
}

async function cacheFirst(req) {
  const cache = await caches.open(LIBS);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  // Only cache complete CORS responses; opaque ones can't be integrity-checked.
  if (res.ok && res.type === 'cors') cache.put(req, res.clone());
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    if (url.pathname === '/sw.js') return;
    if (req.mode === 'navigate') { e.respondWith(networkFirst(req)); return; }
    if (/^\/(css|js|assets)\//.test(url.pathname) || url.pathname === '/favicon.ico') {
      e.respondWith(staleWhileRevalidate(req));
    }
    return;
  }
  // Only versioned library URLs (they contain "@x.y.z" or "/x.y.z/").
  if (LIB_HOSTS.includes(url.hostname) && /[@/]\d+\.\d+\.\d+/.test(url.pathname)) {
    e.respondWith(cacheFirst(req));
  }
});
