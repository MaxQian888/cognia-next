/**
 * HTTP envelope shared by every route: JSON bodies, the `{ code, requestId }`
 * error envelope, bounded body reads, CORS for anonymous reads and the
 * security headers on API responses.
 */

import {
  MAX_REQUEST_BODY_BYTES,
  type StatusErrorBody,
  type StatusErrorCode,
} from "../../../../../lib/status/contract"

export interface RequestContext {
  requestId: string
  nowMs: number
  url: URL
  /** Waits on background work after the response (ExecutionContext). */
  waitUntil(promise: Promise<unknown>): void
}

export function newRequestId(): string {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

export function createRequestContext(
  request: Request,
  ctx: Pick<ExecutionContext, "waitUntil">,
  nowMs = Date.now()
): RequestContext {
  return {
    requestId: request.headers.get("cf-ray") ?? newRequestId(),
    nowMs,
    url: new URL(request.url),
    waitUntil: (promise) => ctx.waitUntil(promise),
  }
}

const API_SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
}

export interface JsonOptions {
  status?: number
  headers?: Record<string, string>
  /** Public, credentials-free cross-origin read. */
  publicRead?: boolean
  /** `Cache-Control` value; defaults to `no-store`. */
  cacheControl?: string
}

export function json(body: unknown, opts: JsonOptions = {}): Response {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": opts.cacheControl ?? "no-store",
    ...API_SECURITY_HEADERS,
    ...opts.headers,
  })
  if (opts.publicRead) applyPublicCors(headers)
  return new Response(JSON.stringify(body), { status: opts.status ?? 200, headers })
}

const STATUS_FOR_CODE: Record<StatusErrorCode, number> = {
  bad_request: 400,
  body_too_large: 413,
  unsupported_schema: 422,
  not_found: 404,
  method_not_allowed: 405,
  unauthorized: 401,
  forbidden: 403,
  conflict: 409,
  revision_conflict: 409,
  too_late: 422,
  rate_limited: 429,
  token_invalid: 400,
  token_expired: 410,
  token_used: 410,
  unavailable: 503,
  internal: 500,
}

export function errorResponse(
  code: StatusErrorCode,
  ctx: Pick<RequestContext, "requestId">,
  extra: { currentRevision?: number; headers?: Record<string, string>; publicRead?: boolean } = {}
): Response {
  const body: StatusErrorBody = { code, requestId: ctx.requestId }
  if (extra.currentRevision !== undefined) body.currentRevision = extra.currentRevision
  return json(body, {
    status: STATUS_FOR_CODE[code],
    headers: extra.headers,
    publicRead: extra.publicRead,
  })
}

export function applyPublicCors(headers: Headers): void {
  headers.set("access-control-allow-origin", "*")
  headers.set("access-control-allow-methods", "GET, HEAD, OPTIONS")
  headers.set("access-control-allow-headers", "if-none-match")
  headers.set("access-control-expose-headers", "etag, x-status-revision")
  headers.set("access-control-max-age", "600")
}

/** Preflight for anonymous GET only; writes get no wildcard CORS. */
export function publicPreflight(): Response {
  const headers = new Headers(API_SECURITY_HEADERS)
  applyPublicCors(headers)
  return new Response(null, { status: 204, headers })
}

export type BodyResult =
  | { ok: true; bytes: Uint8Array; text: string }
  | { ok: false; code: "body_too_large" | "bad_request" }

/**
 * Read at most `limit` bytes. A declared or actual larger body is refused
 * without buffering the rest.
 */
export async function readBoundedBody(
  request: Request,
  limit = MAX_REQUEST_BODY_BYTES
): Promise<BodyResult> {
  const declared = request.headers.get("content-length")
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    return { ok: false, code: "body_too_large" }
  }
  if (!request.body) return { ok: true, bytes: new Uint8Array(), text: "" }
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      await reader.cancel()
      return { ok: false, code: "body_too_large" }
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return {
      ok: true,
      bytes,
      text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    }
  } catch {
    return { ok: false, code: "bad_request" }
  }
}

/** Read and JSON-parse a bounded body; parse errors become `bad_request`. */
export async function readJsonBody(
  request: Request,
  limit = MAX_REQUEST_BODY_BYTES
): Promise<
  | { ok: true; value: unknown; bytes: Uint8Array }
  | { ok: false; code: "body_too_large" | "bad_request" }
> {
  const body = await readBoundedBody(request, limit)
  if (!body.ok) return body
  try {
    return { ok: true, value: JSON.parse(body.text), bytes: body.bytes }
  } catch {
    return { ok: false, code: "bad_request" }
  }
}

/**
 * Structured log line. Callers pass only non-secret identifiers: never raw
 * bodies, room/device IDs, IP addresses, email addresses, tokens or keys.
 */
export function logEvent(
  event: string,
  fields: Record<string, string | number | boolean | null>
): void {
  console.log(JSON.stringify({ event, ...fields }))
}
