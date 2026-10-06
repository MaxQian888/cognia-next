"use client"

/**
 * Platform-routed `fetch` for a user-configured, self-hosted origin.
 *
 * Lifted out of `lib/server-ops/transport.ts` when the diagnostic service
 * console needed the identical routing. The problem is not specific to either
 * subsystem: any host the *user* names — an Ops Controller, a self-hosted
 * diagnostic service — is unreachable from the WebView on every shell, and for
 * a different reason each time.
 *
 *   - **Tauri desktop** — `tauri.conf.json`'s `connect-src` allowlists a fixed
 *     set of origins and a user-entered host is never on it, so a renderer
 *     `fetch` is blocked by CSP before it reaches the network. Requests go
 *     through `createProxyFetch` (the native `proxy_http_request` bridge),
 *     which also applies the desktop proxy policy. `connectorsHttpRequest`
 *     would work too, but carries a 5 req/s per-host token bucket sized for
 *     chat platforms — enough to throttle a fan-out refresh.
 *   - **Capacitor mobile** — the WebView origin is `capacitor://`, and a
 *     self-hosted server sends no CORS headers, so `CapacitorHttp.request` is
 *     the only path. Same reasoning as `lib/webdav/transport.ts`.
 *   - **Web** — an ordinary browser `fetch`, which reaches the host only if it
 *     opts into CORS. [`platformFetchKind`] reports `"browser"` so a caller can
 *     say as much in the UI instead of failing opaquely.
 *
 * This module owns **request/response** routing only. Anything that needs a
 * body which never ends — an SSE stream — cannot use it, because two of the
 * three transports are buffered and resolve on the last byte. Those callers
 * need a dedicated native command; see `supportsLiveOperationEvents`.
 */

import {
  getCapacitorHttp,
  requestCapacitorHttp,
  serializeCapacitorRequestBody,
  decodeCapacitorResponseBody,
  waitForCapacitorResult,
} from "@/lib/connectivity/capacitor-http"
import { createProxyFetch } from "@/lib/network/proxy-fetch"
import { detectPlatform } from "@/lib/platform/detect"
import { measureOperation } from "@/lib/perf/operation-performance"

export type PlatformFetchKind = "tauri" | "capacitor" | "browser"

/**
 * Per-call options the native transports honor on top of `RequestInit`. A
 * plain browser `fetch` ignores both.
 */
export interface PlatformRequestInit extends RequestInit {
  /**
   * Whole-request timeout in ms for the native transports. Default 30 s —
   * fine for API calls, too short for downloading a media file.
   */
  timeout?: number
  /**
   * The response body is bytes, not text. The Capacitor bridge only carries
   * strings, so it must be asked for base64 up front; reading a video as text
   * corrupts it. Desktop and browser read bytes either way.
   */
  binaryResponse?: boolean
}

/** A `fetch`-compatible function. Narrower than `typeof fetch` on purpose. */
export type PlatformFetch = (
  input: RequestInfo | URL,
  init?: PlatformRequestInit
) => Promise<Response>

/** Thrown when the shell has no usable transport at all. */
export class PlatformFetchUnavailableError extends Error {
  constructor(message = "No HTTP transport is available in this shell") {
    super(message)
    this.name = "PlatformFetchUnavailableError"
  }
}

/** Which transport this shell will use for user-configured hosts. */
export function platformFetchKind(): PlatformFetchKind {
  const platform = detectPlatform()
  if (platform === "tauri") return "tauri"
  // `detectPlatform` reports `mobile` for the Capacitor shell, but the native
  // HTTP plugin is what actually decides whether the CORS-free path exists —
  // a mobile web build has the former without the latter.
  if (platform === "mobile" && getCapacitorHttp()) return "capacitor"
  return "browser"
}

/**
 * Whether this shell can reach a host that does not serve CORS headers.
 *
 * False only in the browser, where the request is at the mercy of the target's
 * own CORS policy. Callers use it to explain a failure up front rather than
 * after a network error with no body.
 */
export function reachesNonCorsHosts(): boolean {
  return platformFetchKind() !== "browser"
}

/**
 * `fetch` over `CapacitorHttp`.
 *
 * Binary request bodies are base64-encoded and flagged, because the native
 * bridge only carries strings: without that, an artifact upload would arrive
 * as the string `"[object ArrayBuffer]"`. Responses are read as text unless
 * the caller sets `binaryResponse`, in which case the bridge returns base64
 * and it is decoded back into bytes.
 */
async function capacitorFetch(
  input: RequestInfo | URL,
  init?: PlatformRequestInit
): Promise<Response> {
  const plugin = getCapacitorHttp()
  if (!plugin) throw new PlatformFetchUnavailableError("CapacitorHttp is unavailable")
  const request = new Request(input, init)
  if (request.signal.aborted) throw request.signal.reason
  const body = await waitForCapacitorResult(() => serializeCapacitorRequestBody(request), {
    signal: request.signal,
    timeoutMs: init?.timeout ?? DEFAULT_TIMEOUT_MS,
  })
  const response = await requestCapacitorHttp(
    plugin,
    {
      url: request.url,
      method: request.method as CapacitorMethod,
      ...body,
      // Text, not json: error and success bodies are both JSON here, but a
      // native auto-parse would hand back an object the `Response` constructor
      // cannot take, and every caller parses either way. `blob` makes both
      // native stacks answer with base64.
      responseType: init?.binaryResponse ? "blob" : "text",
      connectTimeout: init?.timeout ?? DEFAULT_TIMEOUT_MS,
      readTimeout: init?.timeout ?? DEFAULT_TIMEOUT_MS,
    },
    { signal: request.signal, timeoutMs: init?.timeout ?? DEFAULT_TIMEOUT_MS }
  )
  return new Response(decodeCapacitorResponseBody(response, init?.binaryResponse, request.method), {
    status: response.status,
    headers: response.headers,
  })
}

const DEFAULT_TIMEOUT_MS = 30_000

type CapacitorMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS"

/**
 * The `fetch` implementation this shell should use for a user-configured host.
 *
 * Injectable dependencies exist so tests can pin a transport without a shell;
 * production passes nothing.
 */
export function createPlatformFetch(
  deps: {
    kind?: PlatformFetchKind
    capacitor?: PlatformFetch
    proxied?: PlatformFetch
    browser?: PlatformFetch
  } = {}
): PlatformFetch {
  const kind = deps.kind ?? platformFetchKind()
  const implementation = selectPlatformFetch(kind, deps)
  // Browser fetch resolves at response headers; native bridges buffer the body.
  // Only the fixed transport name and outcome enter the performance recorder.
  return (input, init) =>
    measureOperation(
      `network.${kind}.fetch`,
      () => implementation(input, init),
      (response) => (response.ok ? "success" : "error")
    )
}

function selectPlatformFetch(
  kind: PlatformFetchKind,
  deps: { capacitor?: PlatformFetch; proxied?: PlatformFetch; browser?: PlatformFetch }
): PlatformFetch {
  switch (kind) {
    case "capacitor":
      return deps.capacitor ?? capacitorFetch
    case "tauri": {
      if (deps.proxied) return deps.proxied
      // Wrapped rather than returned directly: `createProxyFetch` accepts its
      // own `ProxyFetchOptions` init, which is narrower than `RequestInit` and
      // so not assignable to `PlatformFetch` under `strictFunctionTypes`.
      // `timeout` carries straight through to the native `timeout_ms`; the
      // bridge returns bytes regardless, so `binaryResponse` is dropped.
      const proxied = createProxyFetch()
      return (input, init) => {
        if (!init) return proxied(input)
        const { binaryResponse: _binary, ...rest } = init
        return proxied(input, rest)
      }
    }
    default:
      return (
        deps.browser ??
        ((input, init) => {
          if (!init) return fetch(input)
          const { timeout: _timeout, binaryResponse: _binary, ...rest } = init
          return fetch(input, rest)
        })
      )
  }
}
