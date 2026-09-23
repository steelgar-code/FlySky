// FlySky — offline service worker
//
// Strategy: "network-first, falling back to cache". Online, everything comes
// fresh from the network (and the cached copy is refreshed); offline, the
// last good copy is served.
//
// Everything the UI needs to render is cached up front at install time —
// the app files AND the CDN assets (Tailwind, Chart.js, FontAwesome CSS and
// fonts). Relying on runtime caching alone left the app unstyled offline:
// CDN files were only cached once they happened to load through an already
// active worker, and each version bump deleted them with the old cache.
// On activation, anything the new cache is missing is also carried over from
// older FlySky caches before they are deleted.
//
// Open-Meteo API requests are deliberately NOT cached here: every forecast
// URL is unique, so caching them would only grow the cache. The app keeps
// its own copy of the last forecast in localStorage for offline viewing.

const CACHE_PREFIX = 'flysky-cache-';
const CACHE_NAME = CACHE_PREFIX + 'v5';

const APP_FILES = [
    './',
    './index.html',
    './manifest.json',
    './favicon.png',
    './icon-192.png',
    './icon-512.png',
    './icon-maskable-512.png'
];

// Must match the URLs index.html loads. Scripts and the stylesheet are
// requested by the page without CORS ("no-cors"), so they are cached the same
// way (opaque responses); web fonts are always fetched with CORS, so those
// must be cached as CORS responses or the browser will refuse them.
const CDN_NO_CORS = [
    'https://cdn.tailwindcss.com',
    'https://cdn.jsdelivr.net/npm/chart.js',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css'
];
const CDN_CORS = [
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/webfonts/fa-solid-900.woff2',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/webfonts/fa-regular-400.woff2'
];

function cacheable(response) {
    return response && (response.ok || response.type === 'opaque');
}

// Best effort: one unreachable file must not abort the whole install.
function precache(cache, request) {
    return fetch(request)
        .then((response) => (cacheable(response) ? cache.put(request, response) : undefined))
        .catch(() => {});
}

self.addEventListener('install', (event) => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => Promise.all([
            ...APP_FILES.map((url) => precache(cache, new Request(url, { cache: 'reload' }))),
            ...CDN_NO_CORS.map((url) => precache(cache, new Request(url, { mode: 'no-cors' }))),
            ...CDN_CORS.map((url) => precache(cache, new Request(url, { mode: 'cors' })))
        ]))
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil((async () => {
        const current = await caches.open(CACHE_NAME);
        // FlyLog, FlySend, FlyStock and FlySky share the steelgar-code.github.io
        // origin, and Cache Storage is per origin: only FlySky's own old caches
        // may be touched here, never the other apps' offline copies.
        const oldNames = (await caches.keys()).filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME);
        // Carry over anything the new cache lacks (e.g. a CDN file that could
        // not be fetched during install) before dropping the old caches.
        for (const name of oldNames) {
            const old = await caches.open(name);
            for (const request of await old.keys()) {
                if (!(await current.match(request))) {
                    const response = await old.match(request);
                    if (response) await current.put(request, response).catch(() => {});
                }
            }
        }
        await Promise.all(oldNames.map((key) => caches.delete(key)));
        await self.clients.claim();
    })());
});

self.addEventListener('fetch', (event) => {
    // Only handle simple GET requests; let everything else pass through normally.
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
                if (cacheable(networkResponse)) {
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
                // Offline (or the network request failed): serve the last
                // cached copy. For a page navigation, fall back to the cached
                // app shell even if the exact URL (e.g. with a query) differs.
                return caches.match(event.request).then((cached) => {
                    if (cached) return cached;
                    if (event.request.mode === 'navigate') {
                        return caches.match('./index.html').then((shell) => shell || caches.match('./'));
                    }
                    return Response.error();
                });
            })
    );
});
