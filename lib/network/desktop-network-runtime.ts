/**
 * One place that hands every framework-agnostic package the host's network
 * transport.
 *
 * Several `@cognia/*` packages are written with zero app imports and reach the
 * network through a runtime adapter the host installs at boot. Each ships an
 * inert default — a bare `fetch` — that is correct in Node and in a browser
 * tab and wrong in the packaged desktop shell twice over:
 *
 *   - `tauri.conf.json`'s `connect-src` is `'self' ipc: http://ipc.localhost
 *     ws: wss:`. No `http:`/`https:` scheme means a renderer `fetch` to a
 *     provider origin is blocked before it leaves the WebView.
 *   - even where it isn't blocked, a renderer `fetch` never sees the
 *     Off/Manual/Auto proxy the user configured, its bypass list, or its
 *     keyring credentials — those live in Rust.
 *
 * `pnpm dev` runs without a CSP, which is why an uninstalled adapter looks
 * healthy in development and is dead in the packaged app. That failure mode
 * has already shipped more than once here (the OTLP/Langfuse log transports,
 * then the whole local-provider surface), so the fix is one installer rather
 * than one per package.
 *
 * `proxyFetch` is the transport for all of them. Off Tauri it is a
 * passthrough to the platform `fetch`, so installing this on the web and
 * Capacitor builds changes nothing — which is deliberate: this module is the
 * *desktop Host* seam, and the mobile/web shells keep their existing
 * behaviour.
 *
 * Not covered here, on purpose:
 *   - `@cognia/provider-core` and `@cognia/provider-routing` have their own
 *     boot initializers that predate this one and install more than a fetch.
 *   - `@cognia/ocr` installs through `installOcrRuntime({ cloudFetch })`,
 *     because its seam is created by that same call.
 *   - `@cognia/tts` owns `packages/tts/src/proxy-fetch.ts`, already wired.
 */

import { loggers } from "@cognia/logging"
import { setRAGRuntimeAdapters } from "@cognia/rag/runtime-adapters"
import { setWebSearchRuntimeAdapters } from "@cognia/web-search/runtime-adapters"

import { proxyFetch } from "@/lib/network/proxy-fetch"

const log = loggers.network

/** Packages this installer owns, in install order. Read by the wiring test. */
export const DESKTOP_NETWORK_RUNTIME_PACKAGES = ["@cognia/web-search", "@cognia/rag"] as const

export interface DesktopNetworkRuntimeDeps {
  proxyFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  setWebSearchAdapters: typeof setWebSearchRuntimeAdapters
  setRagAdapters: typeof setRAGRuntimeAdapters
}

/**
 * Production dependencies, built lazily.
 *
 * A default-parameter object would be constructed at module scope and its
 * `proxyFetch` captured before the proxy store hydrates. Building it per call
 * keeps the binding late without making every caller pass it.
 */
function defaultDeps(): DesktopNetworkRuntimeDeps {
  return {
    proxyFetch: (input, init) => proxyFetch(input, init),
    setWebSearchAdapters: setWebSearchRuntimeAdapters,
    setRagAdapters: setRAGRuntimeAdapters,
  }
}

let installed = false

/**
 * Install the host transport into every package listed above.
 *
 * Idempotent — a second call is a no-op, so React Strict Mode's double-invoke
 * and the headless host's own bootstrap can both call it.
 */
export function installDesktopNetworkRuntime(
  deps: DesktopNetworkRuntimeDeps = defaultDeps()
): void {
  if (installed) return
  installed = true

  deps.setWebSearchAdapters({ proxyFetch: deps.proxyFetch })
  deps.setRagAdapters({
    proxyFetch: deps.proxyFetch,
    logger: {
      debug: (message, data) => log.debug(message, data),
      info: (message, data) => log.info(message, data),
      warn: (message, data) => log.warn(message, data),
      error: (message, error, data) => log.error(message, error, data),
    },
  })
}

/** Reset state — test-only. */
export function __resetDesktopNetworkRuntime(): void {
  installed = false
}
