"use client"

/**
 * Shared CapacitorHttp helper for the connectivity layer.
 *
 * `CapacitorHttp` has a fetch/XHR interceptor that rewrites URLs to
 * `/_capacitor_http_interceptor_?u=...`. When the mobile app is loaded
 * via `server.url` (dev mode), those rewritten URLs land on the Next.js
 * dev server and 404 because they never reach the native bridge. Calling
 * `CapacitorHttp.request()` directly avoids the interceptor entirely.
 *
 * Both `lan-scanner.ts` (whoami probe) and `healthz.ts` use the same
 * primitive so a single place owns the bypass + the `serverTrustMode:
 * "self-signed"` policy for pre-pair self-signed certs.
 */

export interface CapacitorHttpResponse {
  data: unknown
  status: number
  headers: Record<string, string>
  url: string
}

export interface CapacitorHttpRequest {
  url: string
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS"
  headers?: Record<string, string>
  params?: Record<string, string>
  data?: unknown
  /** Per-request server trust mode. */
  serverTrustMode?: "default" | "self-signed" | "pinned"
  /** Read timeout in ms. */
  readTimeout?: number
  /** Connect timeout in ms. */
  connectTimeout?: number
  responseType?: "text" | "json" | "blob" | "arraybuffer" | "document"
}

export interface CapacitorHttpPlugin {
  request(req: CapacitorHttpRequest): Promise<CapacitorHttpResponse>
}

export function getCapacitorHttp(): CapacitorHttpPlugin | null {
  if (typeof globalThis === "undefined") return null
  const w = globalThis as unknown as {
    Capacitor?: {
      isNativePlatform?: () => boolean
      Plugins?: { CapacitorHttp?: CapacitorHttpPlugin }
    }
  }
  if (!w.Capacitor?.isNativePlatform?.()) return null
  return w.Capacitor.Plugins?.CapacitorHttp ?? null
}

/**
 * Drive a GET request through CapacitorHttp with a bounded timeout +
 * caller-cancellable abort signal. Returns a normalised shape that
 * mirrors enough of `Response` for the connectivity layer's consumers.
 *
 * Returns `null` when the request fails for any reason (timeout, abort,
 * TLS rejection, network unreachable). Callers fall through to their
 * usual non-Capacitor path.
 */
export async function capacitorHttpGet(
  cap: CapacitorHttpPlugin,
  url: string,
  opts: {
    signal: AbortSignal
    timeoutMs: number
    serverTrustMode?: "default" | "self-signed" | "pinned"
  }
): Promise<{ status: number; data: unknown } | null> {
  const { signal, timeoutMs, serverTrustMode = "self-signed" } = opts
  const abortTimer = new Promise<never>((_, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), timeoutMs)
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t)
        reject(new Error("aborted"))
      },
      { once: true }
    )
  })
  try {
    const resp = await Promise.race([
      cap.request({
        url,
        method: "GET",
        serverTrustMode,
        connectTimeout: timeoutMs,
        readTimeout: timeoutMs,
        responseType: "text",
      }),
      abortTimer,
    ])
    return { status: resp.status, data: resp.data }
  } catch {
    return null
  }
}

/**
 * Merge two AbortSignals into one. Prefers the platform `AbortSignal.any`
 * (Node 20.3+, recent browsers); falls back to the local signal in
 * environments without it, since every caller in this module also
 * checks `parent.aborted` between operations.
 *
 * Centralised here so `lan-scanner.ts` + `healthz.ts` share one
 * implementation instead of two near-identical copies.
 */
export function combineAbortSignals(parent: AbortSignal, local: AbortSignal): AbortSignal {
  type AbortSignalCtor = typeof AbortSignal & {
    any?: (signals: readonly AbortSignal[]) => AbortSignal
  }
  const ctor = AbortSignal as AbortSignalCtor
  if (typeof ctor.any === "function") {
    return ctor.any([parent, local])
  }
  return local
}
