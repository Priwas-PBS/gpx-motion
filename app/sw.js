const CACHE_NAME = 'gpx-motion-map-cache-v1';
const MAX_ENTRIES = 1200;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

function isMapResource(url) {
  return url.hostname === 'api.mapbox.com' || url.hostname === 'demotiles.maplibre.org';
}

async function trimCache(cache) {
  const keys = await cache.keys();
  const excess = keys.length - MAX_ENTRIES;
  if (excess <= 0) return;
  await Promise.all(keys.slice(0, excess).map((request) => cache.delete(request)));
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (!isMapResource(url)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok || response.type === 'opaque') {
      event.waitUntil(cache.put(request, response.clone()).then(() => trimCache(cache)));
    }
    return response;
  })());
});
