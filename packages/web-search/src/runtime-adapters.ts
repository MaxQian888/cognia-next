/**
 * Host-installed runtime adapters for `@cognia/web-search`.
 *
 * The package is framework-agnostic and ships an inert default: a bare
 * `fetch`. That default is fine in Node and in the browser, and wrong in the
 * packaged desktop shell, where the renderer runs under a static CSP whose
 * `connect-src` never lists a search provider's origin — so every
 * `fetch("https://api.tavily.com/search")` is blocked before it leaves the
 * WebView, and the desktop proxy the user configured is bypassed even when
 * the request does get out.
 *
 * The host installs `proxyFetch` here at boot (see
 * `lib/network/desktop-network-runtime.ts`), which funnels each provider call
 * through the Rust `proxy_http_request` command — bound by neither CSP nor
 * CORS, and the single place the Off/Manual/Auto proxy policy, its bypass
 * list, and its keyring credentials are applied.
 *
 * Mirrors `@cognia/provider-core`'s `providers/runtime-adapters.ts` and
 * `@cognia/rag`'s `runtime-adapters.ts`; the three are installed together.
 */

export type WebSearchFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export interface WebSearchRuntimeAdapters {
  /** Proxy-aware fetch every search provider request goes through. */
  proxyFetch?: WebSearchFetch
}

const defaultProxyFetch: WebSearchFetch = (input, init) => fetch(input, init)

let adapters: Required<WebSearchRuntimeAdapters> = {
  proxyFetch: defaultProxyFetch,
}

export function setWebSearchRuntimeAdapters(next: WebSearchRuntimeAdapters): void {
  adapters = {
    proxyFetch: next.proxyFetch ?? adapters.proxyFetch,
  }
}

export function resetWebSearchRuntimeAdaptersForTesting(): void {
  adapters = { proxyFetch: defaultProxyFetch }
}

/**
 * True once a host has installed a real transport. Read by diagnostics that
 * would otherwise report "search works" from a `pnpm dev` run where the bare
 * default happens to succeed.
 */
export function hasWebSearchRuntimeAdapters(): boolean {
  return adapters.proxyFetch !== defaultProxyFetch
}

/**
 * The installed transport, resolved per call.
 *
 * Resolved at call time rather than captured at import time: providers are
 * imported during module evaluation, long before the host's boot initializer
 * runs, so a captured reference would pin the inert default forever.
 */
export function webSearchFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return adapters.proxyFetch(input, init)
}
