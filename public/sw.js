// Minimal service worker — app-shell caching so the PWA is installable
// and opens offline. Data always goes to Supabase over the network.
const CACHE = 'ops-dashboard-v1';
const SHELL = ['/', '/index.html', '/manifest.json', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // Never cache Supabase API/realtime traffic.
  if (url.hostname.endsWith('supabase.co')) return;

  // Navigations: network-first, fall back to cached shell.
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('/index.html')));
    return;
  }

  // Static assets: cache-first.
  event.respondWith(
    caches.match(request).then((hit) => hit || fetch(request))
  );
});
