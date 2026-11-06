interface BackgroundSyncManager {
  register(tag: string): Promise<void>
}

interface SyncCapableRegistration extends ServiceWorkerRegistration {
  readonly sync?: BackgroundSyncManager
}

const SYNC_TAG = 'signalcd-reconnect'

export async function registerPwa(): Promise<void> {
  if (!('serviceWorker' in navigator)) return

  try {
    const registration = (await navigator.serviceWorker.register('/sw.js', {
      scope: '/',
      updateViaCache: 'none'
    })) as SyncCapableRegistration
    const ready = (await navigator.serviceWorker.ready) as SyncCapableRegistration

    cacheLoadedResources(ready)
    await requestBackgroundSync(ready)

    window.addEventListener('online', () => {
      cacheLoadedResources(ready)
      void requestBackgroundSync(ready)
    })
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type === 'SIGNALCD_BACKGROUND_SYNC') {
        window.dispatchEvent(new Event('signalcd-background-sync'))
      }
    })

    // Keep the registration reference alive long enough for browsers that defer
    // installation until the current task completes.
    void registration.update().catch(() => undefined)
  } catch {
    // PWA support must not make the local-first editor unavailable. Deployment
    // verification tests the service worker separately and surfaces failures.
  }
}

async function requestBackgroundSync(registration: SyncCapableRegistration): Promise<void> {
  if (!registration.sync) return
  await registration.sync.register(SYNC_TAG).catch(() => undefined)
}

function cacheLoadedResources(registration: ServiceWorkerRegistration): void {
  const loadedResources = performance.getEntriesByType('resource').map((entry) => entry.name)
  const documentResources = Array.from(
    document.querySelectorAll<HTMLScriptElement | HTMLLinkElement>(
      'script[src], link[rel="stylesheet"][href]'
    )
  ).map((element) => (element instanceof HTMLScriptElement ? element.src : element.href))
  const urls = [...new Set([...loadedResources, ...documentResources])]
    .filter((value) => {
      const url = new URL(value, location.href)
      return (
        url.origin === location.origin &&
        (url.pathname.startsWith('/assets/') ||
          url.pathname === '/manifest.webmanifest' ||
          url.pathname === '/icon.svg' ||
          url.pathname === '/icon-192.png' ||
          url.pathname === '/icon-512.png')
      )
    })
    .map((value) => new URL(value, location.href).pathname)
  registration.active?.postMessage({ type: 'CACHE_URLS', urls })
}
