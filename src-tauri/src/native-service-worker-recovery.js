// Runs from the native page-load hook, including when an old PWA worker has
// replaced the document with offline.html and React cannot mount at all.
;(async (devOrigin) => {
  if (
    !["http:", "https:"].includes(location.protocol) ||
    (location.hostname !== "tauri.localhost" && new URL(location.href).origin !== devOrigin) ||
    !("serviceWorker" in navigator)
  ) {
    return
  }

  const root = new URL("/", location.href).href
  const script = new URL("/sw.js", root).href
  const registration = await navigator.serviceWorker.getRegistration(root)
  const controlled = navigator.serviceWorker.controller?.scriptURL === script
  // Another native window can unregister first while this document is still
  // controlled by the old worker. Reload this document too, once detached.
  if (!registration) {
    if (controlled) location.reload()
    return
  }
  if (registration.scope !== root) return
  const worker = registration.active ?? registration.waiting ?? registration.installing
  if (worker?.scriptURL !== script) return

  const removed = await registration.unregister()
  if (controlled && (removed || !(await navigator.serviceWorker.getRegistration(root)))) {
    location.reload()
  }
})(__COGNIA_DEV_ORIGIN__).catch((error) =>
  console.warn("[native-assets] service-worker recovery failed", error)
)
