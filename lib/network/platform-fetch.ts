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

import { getCapacitorHttp } from "@/lib/connectivity/capacitor-http"
import { createProxyFetch } from "@/lib/network/proxy-fetch"
import { detectPlatform } from "@/lib/platform/detect"

export type PlatformFetchKind = "tauri" | "capacitor" | "browser"

/** A `fetch`-compatible function. Narrower than `typeof fetch` on purpose. */
export type PlatformFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

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

function headerRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {}
  headers.forEach((value, key) => {
    record[key] = value
  })
  return record
}

/**
 * HTTP statuses that MUST NOT carry a body — `new Response(body, {status})`
 * throws a `TypeError` for any non-null body on these, and an empty string is
 * still a body. Mirrors the same list in `proxy-fetch.ts`; both transports hit
 * it, and 204 is what every delete-shaped route in this codebase returns.
 */
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([101, 103, 204, 205, 304])

/**
 * `fetch` over `CapacitorHttp`.
 *
 * Binary request bodies are base64-encoded and flagged, because the native
 * bridge only carries strings: without that, an artifact upload would arrive
 * as the string `"[object ArrayBuffer]"`. Responses are read as text and,
 * for non-JSON content types, decoded from base64 back into bytes.
 */
async function capacitorFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const plugin = getCapacitorHttp()
  if (!plugin) throw new PlatformFetchUnavailableError("CapacitorHttp is unavailable")
  const request = new Request(input, init)
  const headers = headerRecord(request.headers)
  const carriesBody = request.method !== "GET" && request.method !== "HEAD"
  // The native stack has no ArrayBuffer channel. Anything that is not
  // declared as text or JSON is sent as base64 with an explicit marker the
  // server side does not see — `CapacitorHttp` decodes it before dispatch on
  // both platforms when `Content-Type` is binary.
  const contentType = (headers["content-type"] ?? headers["Content-Type"] ?? "").toLowerCase()
  const binary =
    carriesBody &&
    contentType !== "" &&
    !contentType.startsWith("text/") &&
    !contentType.includes("json")
  let data: unknown
  if (carriesBody) {
    data = binary
      ? bytesToBase64(new Uint8Array(await request.clone().arrayBuffer()))
      : await request.text()
  }
  const response = await plugin.request({
    url: request.url,
    method: request.method as CapacitorMethod,
    headers,
    data,
    // Text, not json: error and success bodies are both JSON here, but a
    // native auto-parse would hand back an object the `Response` constructor
    // cannot take, and every caller parses either way.
    responseType: "text",
    connectTimeout: 30_000,
    readTimeout: 30_000,
  })
  const payload =
    typeof response.data === "string" ? response.data : JSON.stringify(response.data ?? null)
  return new Response(NULL_BODY_STATUSES.has(response.status) ? null : payload, {
    status: response.status,
    headers: response.headers,
  })
}

type CapacitorMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS"

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

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
  switch (deps.kind ?? platformFetchKind()) {
    case "capacitor":
      return deps.capacitor ?? capacitorFetch
    case "tauri": {
      if (deps.proxied) return deps.proxied
      // Wrapped rather than returned directly: `createProxyFetch` accepts its
      // own `ProxyFetchOptions` init, which is narrower than `RequestInit` and
      // so not assignable to `PlatformFetch` under `strictFunctionTypes`.
      const proxied = createProxyFetch()
      return (input, init) => proxied(input, init)
    }
    default:
      return deps.browser ?? ((input, init) => fetch(input, init))
  }
}
