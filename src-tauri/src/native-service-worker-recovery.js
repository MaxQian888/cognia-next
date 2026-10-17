// Runs from the native page-load hook, including when an old PWA worker has
// replaced the document with offline.html and React cannot mount at all.
;(async () => {
  if (
    !["http:", "https:"].includes(location.protocol) ||
    location.hostname !== "tauri.localhost" ||
    !("serviceWorker" in navigator)
  ) {
    return
  }

  const root = new URL("/", location.href).href
  const script = new URL("/sw.js", root).href
  const registration = await navigator.serviceWorker.getRegistration(root)
  if (!registration || registration.scope !== root) return
  const worker = registration.active ?? registration.waiting ?? registration.installing
  if (worker?.scriptURL !== script) return

  const controlled = navigator.serviceWorker.controller?.scriptURL === script
  if ((await registration.unregister()) && controlled) location.reload()
})().catch((error) => console.warn("[native-assets] service-worker recovery failed", error))
