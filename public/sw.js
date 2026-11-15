// Dinosour service worker: network-first so a deployed update is picked up as
// soon as the device is online, with a cached shell as the offline fallback.
// API, media ranges and cross-origin requests always go straight to the network.
const CACHE = 'dinosour-shell-v6';
const SHELL = ['/', '/startup.js', '/native.js', '/app.js', '/style.css', '/manifest.webmanifest', '/icon.svg',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png', '/icons/apple-touch-icon.png'];

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
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
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
