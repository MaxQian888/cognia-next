/**
 * HTTP seam for the public status page.
 *
 * Every request the `/status` route makes (snapshot, incident pages, incident
 * detail, subscription writes) goes through `statusRequest`, so the timeout,
 * abort, credential and error-classification rules live in one place:
 *
 * - The transport is `createPlatformFetch` (lib/network/platform-fetch.ts).
 *   In a plain browser — the primary page and the mirror — that is the
 *   ordinary `fetch`. Inside Cognia (`app` mode) the official API is a foreign
 *   origin: the Tauri CSP does not allow it in `connect-src` and a Capacitor
 *   WebView has a `capacitor://` origin, so the request has to go through the
 *   native bridge, which is exactly what the platform seam picks. It reads no
 *   account state; the lightweight shell already loads the settings store it
 *   consults for the desktop proxy.
 * - Credentials are always omitted: the status API is anonymous.
 * - A timeout and a caller abort are told apart, so a superseded request is
 *   silent while a slow one becomes a visible "timeout" error.
 * - Every body is validated by the caller's contract parser. An unsupported
 *   schema version is its own error kind and never falls back to anything.
 */

import { createPlatformFetch } from "@/lib/network/platform-fetch"
import {
  isUnsupportedSchemaError,
  parseErrorBody,
  type ParseResult,
  type StatusErrorCode,
} from "@/lib/status/public-status"

/** Plan §11: a GET that has not answered in 8 s is a failure. */
export const STATUS_GET_TIMEOUT_MS = 8_000
/** Writes wait a little longer: the Worker queues mail before it answers. */
export const STATUS_POST_TIMEOUT_MS = 15_000

export type StatusRequestErrorKind = "network" | "timeout" | "http" | "invalid" | "unsupported"

export class StatusRequestError extends Error {
  readonly kind: StatusRequestErrorKind
  /** HTTP status for `http` errors, otherwise null. */
  readonly status: number | null
  /** Contract error code from a `{ code, requestId }` body, when one was sent. */
  readonly code: StatusErrorCode | null
  readonly requestId: string | null
  readonly currentRevision: number | null

  constructor(
    kind: StatusRequestErrorKind,
    detail: {
      status?: number | null
      code?: StatusErrorCode | null
      requestId?: string | null
      currentRevision?: number | null
      message?: string
    } = {}
  ) {
    super(detail.message ?? `status request failed: ${kind}`)
    this.name = "StatusRequestError"
    this.kind = kind
    this.status = detail.status ?? null
    this.code = detail.code ?? null
    this.requestId = detail.requestId ?? null
    this.currentRevision = detail.currentRevision ?? null
  }
}

export function isAbortError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "name" in error &&
    (error as { name: unknown }).name === "AbortError"
  )
}

function abortError(): Error {
  if (typeof DOMException !== "undefined") {
    return new DOMException("The status request was aborted", "AbortError")
  }
  const error = new Error("The status request was aborted")
  error.name = "AbortError"
  return error
}

export interface StatusRequestOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

export interface StatusResponse<T> {
  value: T
  /** Client clock when the response arrived, for freshness calibration. */
  receivedAtMs: number
}

type Parser<T> = (value: unknown) => ParseResult<T>

async function statusRequest<T>(
  url: string,
  init: { method: "GET" | "POST"; body?: unknown },
  parse: Parser<T>,
  options: StatusRequestOptions
): Promise<StatusResponse<T>> {
  const { signal } = options
  if (signal?.aborted) throw abortError()
  const timeoutMs =
    options.timeoutMs ?? (init.method === "GET" ? STATUS_GET_TIMEOUT_MS : STATUS_POST_TIMEOUT_MS)
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const forwardAbort = () => controller.abort()
  signal?.addEventListener("abort", forwardAbort, { once: true })

  let status: number
  let ok: boolean
  let text: string
  let receivedAtMs: number
  try {
    const fetchImpl = createPlatformFetch()
    const headers: Record<string, string> = { accept: "application/json" }
    if (init.body !== undefined) headers["content-type"] = "application/json"
    const response = await fetchImpl(url, {
      method: init.method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      credentials: "omit",
      // Never an HTTP-cached copy: a snapshot's `serverTime` is the page's
      // clock reference, and a replayed body (even one revalidated by ETag)
      // would make an old snapshot look fresh. The Worker's own edge cache
      // bounds load; writes are never cached either.
      cache: "no-store",
      signal: controller.signal,
      timeout: timeoutMs,
    })
    receivedAtMs = Date.now()
    status = response.status
    ok = response.ok
    text = await response.text()
  } catch (error) {
    if (signal?.aborted) throw abortError()
    if (timedOut) throw new StatusRequestError("timeout")
    throw new StatusRequestError("network", {
      message: error instanceof Error ? error.message : String(error),
    })
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", forwardAbort)
  }

  let body: unknown = null
  let jsonOk = true
  if (text.length > 0) {
    try {
      body = JSON.parse(text)
    } catch {
      jsonOk = false
    }
  }

  if (!ok) {
    const parsed = jsonOk ? parseErrorBody(body) : null
    throw new StatusRequestError("http", {
      status,
      code: parsed?.ok ? parsed.value.code : null,
      requestId: parsed?.ok ? parsed.value.requestId : null,
      currentRevision: parsed?.ok ? (parsed.value.currentRevision ?? null) : null,
    })
  }
  if (!jsonOk) throw new StatusRequestError("invalid", { status, message: "response is not JSON" })

  const parsed = parse(body)
  if (!parsed.ok) {
    throw new StatusRequestError(
      isUnsupportedSchemaError(parsed.error) ? "unsupported" : "invalid",
      {
        status,
        message: parsed.error,
      }
    )
  }
  return { value: parsed.value, receivedAtMs }
}

export function statusGet<T>(
  url: string,
  parse: Parser<T>,
  options: StatusRequestOptions = {}
): Promise<StatusResponse<T>> {
  return statusRequest(url, { method: "GET" }, parse, options)
}

export function statusPost<T>(
  url: string,
  body: unknown,
  parse: Parser<T>,
  options: StatusRequestOptions = {}
): Promise<StatusResponse<T>> {
  return statusRequest(url, { method: "POST", body }, parse, options)
}

/** Parser for bodies that are exactly `{ status: <expected> }`. */
export function statusLiteralParser<S extends string>(expected: S): Parser<{ status: S }> {
  return (value) =>
    value !== null &&
    typeof value === "object" &&
    (value as { status?: unknown }).status === expected
      ? { ok: true, value: { status: expected } }
      : { ok: false, error: `$.status: expected ${expected}` }
}
