// Dinosour service worker: network-first so a deployed update is picked up as
// soon as the device is online, with a cached shell as the offline fallback.
// API, media ranges and cross-origin requests always go straight to the network.
const CACHE = 'dinosour-shell-v16';
const SHELL = ['/', '/startup.js', '/native.js', '/native-api.js', '/app.js', '/style.css', '/manifest.webmanifest', '/icon.svg',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png', '/icons/apple-touch-icon.png', '/icons/favicon-32.png'];

// Delete every cache that is not the current shell cache. Older
// dinosour-shell-vN versions from a previous install are dropped here so a
// freshly activated worker cannot serve a stale shell.
async function purgeOldCaches() {
  const keys = await caches.keys();
  await Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)));
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Pre-cache what we can; one missing asset must not prevent installation.
    const results = await Promise.allSettled(SHELL.map(path => cache.add(path)));
    const failed = SHELL.filter((_, i) => results[i].status === 'rejected');
    if (failed.length) console.warn('[sw] pre-cache failed for:', failed.join(', '));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil(
    purgeOldCaches().then(() => self.clients.claim())
  );
});

// Message handler: lets the page ask an already-activated worker to purge
// older cache versions (e.g. right after an update is detected) without
// waiting for a full activate cycle. Safe to call any number of times.
self.addEventListener('message', event => {
  const type = typeof event.data === 'string' ? event.data : event.data?.type;
  if (type === 'PURGE_OLD_CACHES') event.waitUntil(purgeOldCaches());
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok && response.type === 'basic') cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(request, { ignoreSearch: request.mode === 'navigate' });
    if (cached) return cached;
    if (request.mode === 'navigate') {
      // Offline navigation to any same-origin route: serve the cached shell
      // instead of a network error so the installed PWA still opens.
      const shell = await cache.match('/');
      if (shell) return shell;
    }
    throw error;
  }
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (request.headers.has('range')) return;
  event.respondWith(networkFirst(request));
});
