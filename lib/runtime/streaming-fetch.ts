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

/**
 * Providers whose official endpoint answers a browser-origin request, so the
 * standalone (BYOK) path can stream straight from the WebView with no desktop
 * host in the middle. Anthropic needs the opt-in header from
 * `browserDirectHeaders`, OpenAI and Google reply with permissive CORS.
 *
 * Deliberately a literal rather than something derived:
 *
 * 1. It is keyed by provider **id**, while `browserDirectHeaders` is keyed by
 *    wire **protocol**. Several catalog entries speak the `openai` protocol
 *    without being `api.openai.com`, and their own CORS policy is their own.
 * 2. Once a user points a provider at a custom `baseURL` (a gateway, a proxy,
 *    a local runtime), whether that origin sends `Access-Control-Allow-Origin`
 *    is not decidable from anything we hold statically. Callers that care about
 *    a custom endpoint have to say so themselves.
 */
export const BROWSER_STREAMING_PROVIDER_IDS = ["anthropic", "openai", "google"] as const

export type BrowserStreamingProviderId = (typeof BROWSER_STREAMING_PROVIDER_IDS)[number]

/**
 * True when this provider's official endpoint is reachable from a browser
 * origin. Says nothing about a custom `baseURL`: see the note on
 * `BROWSER_STREAMING_PROVIDER_IDS`.
 */
export function streamsDirectFromBrowser(
  providerId: string | null | undefined
): providerId is BrowserStreamingProviderId {
  return (
    typeof providerId === "string" &&
    (BROWSER_STREAMING_PROVIDER_IDS as readonly string[]).includes(providerId)
  )
}
