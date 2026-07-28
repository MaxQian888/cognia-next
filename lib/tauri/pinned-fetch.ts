"use client"

/**
 * Pinned-fetch (P0.2) — HTTPS request helper that routes through the native
 * Capacitor HTTP plugin when available so we can trust the desktop server's
 * self-signed certificate.
 *
 * # Why this exists
 *
 * After M2.9 the companion server terminates HTTPS with a self-signed cert
 * (`src-tauri/src/companion_api/tls.rs`). The browser-level `fetch` and
 * `WebSocket` rely on the OS trust store, which won't accept that cert.
 *
 * On Capacitor we use `@capacitor/core`'s `CapacitorHttp` plugin which runs
 * on the native HTTP stack (URLSession / OkHttp) and supports a
 * `serverTrustMode: "self-signed" | "pinned" | "default"` per-request flag.
 *
 * # Current trust model (honest)
 *
 * - **Web / dev** (`!isCapacitor`): uses the platform `fetch` — plain HTTP
 *   only, or HTTPS with OS trust. Cannot reach the desktop's self-signed
 *   cert; mobile dev runs against a separate dev server.
 * - **Capacitor LAN**: `serverTrustMode: "self-signed"`. Accepts the
 *   server's cert without chain validation. Identity is established via
 *   the QR-encoded fingerprint stored in `CompanionConfig.serverFingerprint`,
 *   which the JS layer compares against `/api/v1/whoami` server response
 *   data (see P0.3). This is **not** strict TLS pinning — true pinning
 *   requires runtime cert hash injection (Android Network Security Config /
 *   iOS Info.plist) which is tracked in `mobile/docs/p0-tls-trust-setup.md`.
 * - **Capacitor tunnel** (cloudflared): `serverTrustMode: "default"`.
 *   Standard OS trust chain since Cloudflare issues a real cert.
 *
 * # WebSocket caveat
 *
 * Capacitor does not ship a native WebSocket plugin with cert pinning. WS
 * traffic uses the browser `WebSocket` API and inherits its trust model —
 * same self-signed acceptance question. Android Network Security Config /
 * iOS ATS exception covers this at the platform layer; same TODOs apply.
 */

// CapacitorHttp shim — types + runtime detector are owned by the
// connectivity layer so the LAN scanner, healthz probe, and this fetch
// wrapper all speak the same plugin shape.
import { getCapacitorHttp, type CapacitorHttpRequest } from "@/lib/connectivity/capacitor-http"

function pickTrustMode(
  url: string,
  hasPinnedFingerprint: boolean
): "default" | "self-signed" | "pinned" {
  // Tunnel hosts get Cloudflare's real cert — standard validation.
  if (/\.trycloudflare\.com$/i.test(new URL(url).hostname)) {
    return "default"
  }
  // LAN: self-signed acceptance plus app-layer fingerprint check (P0.3).
  // TODO(P0.2 native): switch to "pinned" once Network Security Config /
  // Info.plist carry the cert hash at build time.
  return hasPinnedFingerprint ? "self-signed" : "default"
}

export interface PinnedFetchInit extends Omit<RequestInit, "body"> {
  body?: BodyInit | null
  /** Pinned SHA-256 SPKI fingerprint (lower-case hex) from the pair payload. */
  serverFingerprint?: string
}

/**
 * Fetch wrapper that uses CapacitorHttp on native platforms (with the right
 * `serverTrustMode`) and falls through to the platform `fetch` elsewhere.
 *
 * Returns a standard `Response` so the caller code shape is unchanged.
 */
export async function pinnedFetch(url: string, init: PinnedFetchInit = {}): Promise<Response> {
  const cap = getCapacitorHttp()
  if (!cap) {
    // Web / dev / fallback path — strip the non-standard option before
    // delegating to platform fetch.
    const { serverFingerprint: _unused, ...standard } = init
    void _unused
    return fetch(url, standard)
  }

  const headers = normalizeHeaders(init.headers)
  const method = (init.method ?? "GET").toUpperCase() as CapacitorHttpRequest["method"]
  const trustMode = pickTrustMode(url, Boolean(init.serverFingerprint))

  const resp = await cap.request({
    url,
    method,
    headers,
    data: init.body,
    serverTrustMode: trustMode,
    responseType: "text",
  })

  return buildResponseLike(resp.status, resp.headers, resp.data)
}

/**
 * Build a `Response`-shaped object without depending on the global
 * `Response` constructor (jsdom doesn't ship it). Covers the subset of
 * `Response` that callers in this codebase actually use: `ok`, `status`,
 * `statusText`, `headers.get`, `text()`, `json()`.
 */
function buildResponseLike(
  status: number,
  headers: Record<string, string>,
  data: unknown
): Response {
  const text = typeof data === "string" ? data : JSON.stringify(data)
  const bytes =
    data instanceof ArrayBuffer
      ? data
      : ArrayBuffer.isView(data)
        ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
        : new TextEncoder().encode(text).buffer
  const lowerHeaders: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    lowerHeaders[k.toLowerCase()] = v
  }
  const responseLike = {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    headers: {
      get(name: string): string | null {
        return lowerHeaders[name.toLowerCase()] ?? null
      },
    },
    text: async () => text,
    json: async () => JSON.parse(text),
    arrayBuffer: async () => bytes,
  }
  return responseLike as unknown as Response
}

function normalizeHeaders(input: HeadersInit | undefined): Record<string, string> {
  if (!input) return {}
  if (input instanceof Headers) {
    const out: Record<string, string> = {}
    input.forEach((v, k) => {
      out[k] = v
    })
    return out
  }
  if (Array.isArray(input)) {
    return Object.fromEntries(input)
  }
  return { ...(input as Record<string, string>) }
}
