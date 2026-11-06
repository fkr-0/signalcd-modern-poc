const CACHE_NAME = 'signalcd-modern-poc-v0.0.6'
const SHELL_URLS = ['/', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png']

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_URLS)))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith('signalcd-modern-poc-') && key !== CACHE_NAME)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  )
})

self.addEventListener('message', (event) => {
  if (event.data?.type !== 'CACHE_URLS' || !Array.isArray(event.data.urls)) return
  const urls = event.data.urls.filter(
    (url) => typeof url === 'string' && (url.startsWith('/assets/') || SHELL_URLS.includes(url))
  )
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll([...new Set(urls)])))
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/__toy__/')) return

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request))
    return
  }
  event.respondWith(cacheFirst(request))
})

self.addEventListener('sync', (event) => {
  if (event.tag !== 'signalcd-reconnect') return
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clients) =>
        Promise.all(
          clients.map((client) => client.postMessage({ type: 'SIGNALCD_BACKGROUND_SYNC' }))
        )
      )
  )
})

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME)
  try {
    const response = await fetch(request)
    if (response.ok) await cache.put(request, response.clone())
    return response
  } catch {
    return (
      (await cache.match(request, { ignoreVary: true })) ??
      (await cache.match('/', { ignoreVary: true })) ??
      Response.error()
    )
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME)
  // Vite preview and several static hosts emit `Vary: Origin` on modules. The
  // install-time cache request has no Origin header while browser module loads
  // do, so strict Cache API matching misses an otherwise identical immutable
  // asset in Chromium. The cache is same-origin-only above; ignoring Vary here
  // is therefore both bounded and required for reliable offline module loads.
  const cached = await cache.match(request, { ignoreVary: true })
  if (cached) return cached
  const response = await fetch(request)
  if (response.ok) await cache.put(request, response.clone())
  return response
}
