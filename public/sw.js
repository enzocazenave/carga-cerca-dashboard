'use strict';

// Service worker de la app cliente (mapa + vista de cargador). El panel
// admin ("/", "/chargers/:id") no lo usa. Estrategia:
//  - Datos en vivo (/api/*) y todo lo cross-origin (tiles del mapa, CDNs):
//    directo a la red, nunca cacheado (necesitan estar siempre frescos).
//  - Assets propios (HTML/JS/manifest/íconos): stale-while-revalidate,
//    para que abra instantáneo y quede utilizable con mala conexión.

const CACHE_NAME = 'cargacerca-v1';
const APP_SHELL = [
  '/mapa',
  '/mapa.js',
  '/cliente.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // tiles del mapa, CDNs
  if (url.pathname.startsWith('/api/')) return; // estado en vivo: siempre red

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(request);
      const network = fetch(request)
        .then((res) => {
          if (res && res.ok) cache.put(request, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
