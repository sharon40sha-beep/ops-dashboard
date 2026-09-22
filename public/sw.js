// Minimal service worker — just enough to make the app installable and to
// serve the shell when offline. Data requests (Supabase) always go to network.
const CACHE = 'ops-shell-v1'
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png']

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
    ).then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  const url = new URL(request.url)

  // Never cache Supabase / cross-origin API calls — always live.
  if (url.origin !== self.location.origin) return

  // Network-first for page navigations (so new deploys are picked up).
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('/index.html')))
    return
  }

  // Cache-first for same-origin static assets.
  event.respondWith(caches.match(request).then((cached) => cached || fetch(request)))
})
