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
 * primitive so a single place owns the bypass and request lifecycle.
 * Stock CapacitorHttp uses OS certificate trust; custom pinning requires
 * explicit native capability attestation at its caller.
 */

export interface CapacitorHttpResponse {
  data: unknown
  status: number
  headers: Record<string, string>
  url: string
}

export interface CapacitorHttpRequest {
  url: string
  // WebDAV verbs (PROPFIND/MKCOL) are passed straight to the native HTTP
  // stack (OkHttp / URLSession), which accepts arbitrary method tokens.
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS" | "PROPFIND" | "MKCOL"
  headers?: Record<string, string>
  params?: Record<string, string>
  data?: unknown
  dataType?: "file" | "formData"
  /** Custom bridge extension. Stock CapacitorHttp does not implement it. */
  serverTrustMode?: "default" | "self-signed" | "pinned"
  /** SHA-256 SPKI fingerprint required when serverTrustMode is `pinned`. */
  serverFingerprint?: string
  /** Read timeout in ms. */
  readTimeout?: number
  /** Connect timeout in ms. */
  connectTimeout?: number
  responseType?: "text" | "json" | "blob" | "arraybuffer" | "document"
}

/**
 * Cancel the JS wait and discard late results. Stock CapacitorHttp cannot
 * cancel native I/O; connect/read timeouts still bound that operation.
 */
export function waitForCapacitorResult<T>(
  start: () => Promise<T>,
  options: { signal?: AbortSignal | null; timeoutMs?: number } = {}
): Promise<T> {
  const { signal, timeoutMs } = options
  const abortReason = () => signal?.reason ?? new DOMException("Request aborted", "AbortError")
  if (signal?.aborted) return Promise.reject(abortReason())
  return new Promise((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (error: boolean, value: unknown) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      if (error) reject(value)
      else resolve(value as T)
    }
    const onAbort = () => finish(true, abortReason())
    signal?.addEventListener("abort", onAbort, { once: true })
    if (timeoutMs !== undefined) {
      timer = setTimeout(
        () => finish(true, new DOMException("Request timed out", "TimeoutError")),
        timeoutMs
      )
    }
    try {
      start().then(
        (value) => finish(false, value),
        (error) => finish(true, error)
      )
    } catch (error) {
      finish(true, error)
    }
  })
}

export function requestCapacitorHttp(
  cap: CapacitorHttpPlugin,
  request: CapacitorHttpRequest,
  options: { signal?: AbortSignal | null; timeoutMs?: number } = {}
): Promise<CapacitorHttpResponse> {
  return waitForCapacitorResult(() => cap.request(request), options)
}

export interface CapacitorHttpPlugin {
  request(req: CapacitorHttpRequest): Promise<CapacitorHttpResponse>
  /**
   * Custom native bridge attestation. Stock CapacitorHttp does not implement
   * SPKI pinning and must never be treated as if it did merely because it
   * ignores unknown request fields.
   */
  getSecurityCapabilities?(): Promise<{ spkiPinning: boolean }>
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
  }
): Promise<{ status: number; data: unknown } | null> {
  const { signal, timeoutMs } = opts
  try {
    const resp = await requestCapacitorHttp(
      cap,
      {
        url,
        method: "GET",
        connectTimeout: timeoutMs,
        readTimeout: timeoutMs,
        responseType: "text",
      },
      { signal, timeoutMs }
    )
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

/** Serialize a Fetch body once, including multipart boundaries and typed-array slices. */
export async function serializeCapacitorRequestBody(request: Request): Promise<{
  headers: Record<string, string>
  data?: string
  dataType?: "file"
}> {
  const headers: Record<string, string> = {}
  request.headers.forEach((value, key) => {
    headers[key] = value
  })
  if (request.body === null) return { headers }
  const contentType = (headers["content-type"] ?? "").toLowerCase()
  if (contentType.startsWith("text/") || contentType.includes("json")) {
    return { headers, data: await request.text() }
  }
  if (!contentType) headers["content-type"] = "application/octet-stream"
  const bytes = new Uint8Array(await request.arrayBuffer())
  let binary = ""
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return { headers, data: btoa(binary), dataType: "file" }
}

/** Native JSON responses are parsed even when blob was requested. */
export function decodeCapacitorResponseBody(
  response: Pick<CapacitorHttpResponse, "status" | "headers" | "data">,
  binaryResponse = false,
  method = "GET"
): string | Uint8Array<ArrayBuffer> | null {
  if (method === "HEAD" || [204, 205, 304].includes(response.status)) return null
  const contentType =
    Object.entries(response.headers).find(([key]) => key.toLowerCase() === "content-type")?.[1] ??
    ""
  const isNativeJson = contentType.toLowerCase().includes("application/json")
  if (binaryResponse && typeof response.data === "string" && !isNativeJson) {
    const binary = atob(response.data)
    const bytes = new Uint8Array(new ArrayBuffer(binary.length))
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
    return bytes
  }
  if (binaryResponse && isNativeJson) return JSON.stringify(response.data ?? null)
  return typeof response.data === "string" ? response.data : JSON.stringify(response.data ?? null)
}
