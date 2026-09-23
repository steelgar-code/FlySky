// FlySky — offline service worker
//
// Strategy: "network-first, falling back to cache" for the app shell and
// its CDN assets (Tailwind, FontAwesome, Chart.js), so the UI loads with no
// network once it has been opened online at least once.
//
// Open-Meteo API requests are deliberately NOT cached here: every forecast
// URL is unique, so caching them would only grow the cache. The app keeps
// its own copy of the last forecast in localStorage for offline viewing.

const CACHE_NAME = 'flysky-cache-v4';
const PRECACHE_URLS = [
    './',
    './index.html',
    './manifest.json',
    './favicon.png',
    './icon-192.png',
    './icon-512.png',
    './icon-maskable-512.png'
];

self.addEventListener('install', (event) => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return Promise.all(
                PRECACHE_URLS.map((url) => cache.add(url).catch(() => {}))
            );
        })
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
        )
    );
    self.clients.claim();
});

self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;
    if (!event.request.url.startsWith('http')) return;
    // Let API calls go straight to the network.
    if (new URL(event.request.url).hostname.endsWith('open-meteo.com')) return;

    event.respondWith(
        fetch(event.request)
            .then((networkResponse) => {
                // Only keep good copies: a 404/500 must never replace a working
                // cached file. Cross-origin CDN assets load as opaque responses
                // (status unknown), which are fine to cache.
                if (networkResponse.ok || networkResponse.type === 'opaque') {
                    const copy = networkResponse.clone();
                    event.waitUntil(
                        caches.open(CACHE_NAME)
                            .then((cache) => cache.put(event.request, copy))
                            .catch(() => {})
                    );
                }
                return networkResponse;
            })
            .catch(() => {
                return caches.match(event.request).then((cached) => {
                    return cached || Response.error();
                });
            })
    );
});
