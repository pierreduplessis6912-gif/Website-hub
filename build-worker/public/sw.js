// TenderLogix Service Worker
// Minimal — just enough to enable PWA install prompt
// No aggressive caching — all data fetches must be fresh

const CACHE_NAME = 'tl-shell-v1';

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(clients.claim());
});

// Pass all fetch requests through — no caching
self.addEventListener('fetch', (e) => {
  e.respondWith(fetch(e.request));
});
