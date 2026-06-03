/**
 * Shared HTTP helpers for cloud OCR providers.
 *
 * Every cloud provider goes through `cloudFetch()` so credential checks,
 * timeout / signal plumbing, and HTTP-status -> OcrError mapping land in one
 * spot instead of being copy-pasted across nine provider files.
 */

import { type OcrErrorCode } from "@/types/ocr"
import { OcrError } from "@/lib/ocr/errors"

export interface CloudFetchOptions {
  url: string
  method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH"
  headers?: Record<string, string>
  /** Body is sent as-is when string/Uint8Array; JSON-encoded when object. */
  body?: string | Uint8Array | object
  signal?: AbortSignal
  /** Provider id for error wrapping. */
  providerId: string
  /**
   * Maps an HTTP status to an explicit OcrErrorCode. The default mapping
   * handles 401/403 -> missing_credentials, 429 -> rate_limited, 4xx -> invalid_input,
   * 5xx -> provider_failed.
   */
  errorCodeFor?: (status: number) => OcrErrorCode
  /** Override fetch — primarily used in tests. */
  fetchImpl?: typeof fetch
}

export interface CloudFetchResponse {
  status: number
  headers: Headers
  body: string
}

export function defaultErrorCodeFor(status: number): OcrErrorCode {
  if (status === 401 || status === 403) return "missing_credentials"
  if (status === 429) return "rate_limited"
  if (status >= 400 && status < 500) return "invalid_input"
  return "provider_failed"
}

function encodeBody(body: CloudFetchOptions["body"]): {
  payload: BodyInit | undefined
  contentType: string | undefined
} {
  if (body === undefined) return { payload: undefined, contentType: undefined }
  if (typeof body === "string") return { payload: body, contentType: undefined }
  if (body instanceof Uint8Array) {
    return { payload: body as BodyInit, contentType: "application/octet-stream" }
  }
  return { payload: JSON.stringify(body), contentType: "application/json" }
}

export async function cloudFetch(opts: CloudFetchOptions): Promise<CloudFetchResponse> {
  const fetchFn = opts.fetchImpl ?? globalThis.fetch
  if (!fetchFn) {
    throw new OcrError("provider_failed", opts.providerId, "fetch is unavailable in this runtime")
  }
  if (opts.signal?.aborted) {
    throw new OcrError("aborted", opts.providerId, "OCR request was cancelled.")
  }
  const { payload, contentType } = encodeBody(opts.body)
  const headers = { ...(opts.headers ?? {}) }
  if (contentType && !headers["Content-Type"] && !headers["content-type"]) {
    headers["Content-Type"] = contentType
  }
  let response: Response
  try {
    response = await fetchFn(opts.url, {
      method: opts.method ?? "POST",
      headers,
      body: payload,
      signal: opts.signal,
    })
  } catch (err) {
    if (err instanceof DOMException && (err.name === "AbortError" || err.message === "aborted")) {
      throw new OcrError("aborted", opts.providerId, "OCR request was cancelled.", err)
    }
    throw new OcrError(
      "provider_failed",
      opts.providerId,
      err instanceof Error ? err.message : String(err),
      err
    )
  }
  const text = await response.text()
  if (!response.ok) {
    const code = (opts.errorCodeFor ?? defaultErrorCodeFor)(response.status)
    throw new OcrError(
      code,
      opts.providerId,
      `${opts.providerId} HTTP ${response.status}: ${truncate(text, 240)}`
    )
  }
  return { status: response.status, headers: response.headers, body: text }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`
}

/** Parse a JSON response body, raising provider_failed on invalid JSON. */
export function parseJson<T>(providerId: string, body: string): T {
  try {
    return JSON.parse(body) as T
  } catch (err) {
    throw new OcrError(
      "provider_failed",
      providerId,
      `Failed to parse ${providerId} response as JSON`,
      err
    )
  }
}

/** Require a credential secret. Throws missing_credentials when absent. */
export function requireSecret(
  providerId: string,
  secrets: Record<string, string>,
  key: string
): string {
  const value = secrets[key]
  if (!value || value.length === 0) {
    throw new OcrError(
      "missing_credentials",
      providerId,
      `${providerId} requires the "${key}" credential.`
    )
  }
  return value
}
