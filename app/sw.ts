/// <reference lib="webworker" />
/**
 * Serwist service worker (Wave 4 / ADR-0026).
 *
 * Compiled by `@serwist/next` at build time. The `swSrc` config in
 * `next.config.ts` points here; `swDest` is `public/sw.js`. Disabled for
 * Capacitor mobile builds (the iOS WKWebView's `capacitor://localhost`
 * scheme rejects SW registration); enabled on web + Tauri.
 *
 * Runtime caching strategy:
 *   - **NetworkFirst** for `/api/v1/_rpc/sync_pull` — the sync orchestrator
 *     is the canonical source; the SW only serves cached responses if the
 *     network times out (4s) so users see SOMETHING instead of a blank
 *     screen when the desktop server is unreachable.
 *   - **StaleWhileRevalidate** for images so avatars / OCR previews load
 *     instantly on repeat visits.
 *   - **defaultCache** handles static assets (JS/CSS/HTML/fonts) via
 *     Serwist's built-in precache manifest.
 *
 * Skip rules:
 *   - `companion://*` schemes (Tauri IPC) — never cache.
 *   - Responses with `Cache-Control: no-store`.
 *   - Cross-origin requests not in scope.
 *   - `Range`-header requests (Monaco worker chunks).
 */

import { defaultCache } from "@serwist/next/worker"
import type { PrecacheEntry, SerwistGlobalConfig } from "serwist"
import { ExpirationPlugin, NetworkFirst, Serwist, StaleWhileRevalidate } from "serwist"

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined
  }
}

declare const self: ServiceWorkerGlobalScope & {
  __SW_MANIFEST: (PrecacheEntry | string)[] | undefined
}

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: [
    {
      matcher: ({ url }) => url.pathname.startsWith("/api/v1/_rpc/sync_pull"),
      handler: new NetworkFirst({
        cacheName: "sync-pull",
        networkTimeoutSeconds: 4,
        plugins: [new ExpirationPlugin({ maxEntries: 60, maxAgeSeconds: 60 * 60 })],
      }),
    },
    {
      matcher: ({ request }) => request.destination === "image",
      handler: new StaleWhileRevalidate({
        cacheName: "images",
        plugins: [new ExpirationPlugin({ maxEntries: 200, maxAgeSeconds: 7 * 24 * 60 * 60 })],
      }),
    },
    ...defaultCache,
  ],
})

serwist.addEventListeners()
