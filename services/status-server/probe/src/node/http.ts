/**
 * Bounded HTTP GET used by the monitoring-plane checks and the mirror sync:
 * a hard timeout, no redirects (a redirect is a status, not a success), and a
 * body cap so a misbehaving origin cannot make the runner buffer megabytes.
 */

import type { ReasonCode } from "../../../../../lib/status/contract"
import { ProbeTransportError } from "../core/types"

const DNS_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "EAI_FAIL", "EAI_NONAME", "EAI_NODATA"])
const CONNECT_TIMEOUT_CODES = new Set([
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
])

/** Map a Node/undici network error to a bounded reason. */
export function classifyNetworkError(error: unknown): ReasonCode {
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current)
    const record = current as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown }
    const code = typeof record.code === "string" ? record.code : ""
    if (record.name === "TimeoutError") return "timeout"
    if (DNS_CODES.has(code)) return "dns_error"
    if (CONNECT_TIMEOUT_CODES.has(code)) return "timeout"
    if (
      code.startsWith("ERR_TLS") ||
      code.startsWith("ERR_SSL") ||
      code.startsWith("CERT_") ||
      code.includes("CERT") ||
      code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
      code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
      code === "SELF_SIGNED_CERT_IN_CHAIN" ||
      code === "EPROTO"
    ) {
      return "tls_error"
    }
    if (code) return "connect_error"
    current = record.cause
  }
  return "connect_error"
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface TextResponse {
  status: number
  contentType: string
  /** Null when the body exceeded `maxBytes`. */
  text: string | null
  bytes: Uint8Array | null
}

export interface GetTextOptions {
  timeoutMs: number
  maxBytes: number
  signal?: AbortSignal
  accept?: string
  userAgent?: string
  fetchImpl?: FetchLike
}

export async function getText(url: string, options: GetTextOptions): Promise<TextResponse> {
  const timeout = AbortSignal.timeout(options.timeoutMs)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  const fetchImpl = options.fetchImpl ?? fetch
  const fail = (error: unknown): never => {
    if (options.signal?.aborted) throw error
    if (timeout.aborted) throw new ProbeTransportError("timeout")
    throw new ProbeTransportError(classifyNetworkError(error))
  }
  let response: Response
  try {
    response = await fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      signal,
      headers: {
        accept: options.accept ?? "*/*",
        "user-agent": options.userAgent ?? "cognia-status-probe",
      },
    })
  } catch (error) {
    return fail(error)
  }
  const contentType = response.headers.get("content-type") ?? ""
  try {
    const bytes = await readBoundedBytes(response, options.maxBytes)
    return {
      status: response.status,
      contentType,
      bytes,
      text: bytes === null ? null : new TextDecoder().decode(bytes),
    }
  } catch (error) {
    return fail(error)
  }
}

async function readBoundedBytes(response: Response, limit: number): Promise<Uint8Array | null> {
  if (!response.body) return new Uint8Array(0)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}
