// Streaming-capable `fetch` for the standalone (BYOK) chat path.
//
// Problem: the mobile shell enables `CapacitorHttp` (mobile/capacitor.config.ts),
// which patches the global `fetch`/`XHR` to route through the native HTTP stack.
// That native path BUFFERS the whole response body (`responseType: "text"`), so
// the Vercel AI SDK's SSE stream collapses into a single chunk — no token
// streaming. When CapacitorHttp patches `window.fetch`, Capacitor stashes the
// original browser `fetch` (which DOES expose a `ReadableStream` body) on
// `window.CapacitorWebFetch`. We use that native browser fetch for streaming.
//
// The trade-off: the native browser fetch is subject to CORS. Official providers
// allow browser-origin requests — Anthropic via the
// `anthropic-dangerous-direct-browser-access` opt-in header (see
// `browserDirectHeaders`), OpenAI/Google via permissive CORS. Custom / local
// endpoints without CORS are out of scope for v1 (tracked for a native
// streaming-HTTP plugin follow-up).

import { isCapacitor } from "@/lib/platform/detect"

interface CapacitorFetchWindow {
  /** Original browser fetch, stashed by Capacitor when CapacitorHttp patches `fetch`. */
  CapacitorWebFetch?: typeof globalThis.fetch
}

/**
 * Return a `fetch` that streams response bodies. On Capacitor this is the
 * un-patched native browser fetch (`window.CapacitorWebFetch`), bypassing the
 * buffering CapacitorHttp patch; elsewhere it is the platform's global `fetch`.
 * Falls back to the global fetch when the stashed native fetch is unavailable
 * (the request still works, just without incremental streaming).
 */
export function getStreamingFetch(): typeof globalThis.fetch {
  if (typeof window !== "undefined" && isCapacitor()) {
    const native = (window as unknown as CapacitorFetchWindow).CapacitorWebFetch
    if (typeof native === "function") return native.bind(window)
  }
  // Guard against environments without a global fetch (e.g. SSR / test) so we
  // never throw on `.bind`; downstream callers treat a missing fetch as "use
  // the provider default".
  return typeof globalThis.fetch === "function"
    ? globalThis.fetch.bind(globalThis)
    : globalThis.fetch
}

/**
 * Per-protocol headers needed to make a browser-origin (CORS) request succeed.
 * Anthropic requires the explicit browser-direct opt-in; OpenAI / Google reply
 * with permissive CORS and need nothing extra.
 */
export function browserDirectHeaders(protocol: string | undefined): Record<string, string> {
  if (protocol === "anthropic") {
    return { "anthropic-dangerous-direct-browser-access": "true" }
  }
  return {}
}
