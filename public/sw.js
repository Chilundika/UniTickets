// Low-bandwidth support: public pages and assets load from cache when the network is slow or down.
// API calls are never cached (they carry personal or live data).
const CACHE = 'helpdesk-v3';
const ASSETS = ['/', '/index.html', '/report.html', '/qr-home.js', '/track.html', '/styles.css', '/common.js', '/intake.js', '/track.js'];

self.addEventListener('install', (e) => e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  if (!ASSETS.includes(url.pathname)) return;
  // Network first (fresh content), cache as fallback.
  e.respondWith(fetch(e.request).then((res) => {
    const copy = res.clone();
    caches.open(CACHE).then((c) => c.put(e.request, copy));
    return res;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
