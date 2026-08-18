/**
 * Host-neutral HTTP for the Google document provider.
 *
 * Google's APIs do send CORS headers, so a browser `fetch` would work — but the
 * connection's OAuth callback needs the Rust loopback listener regardless, so
 * the provider is desktop-only either way and there is no reason to maintain
 * two transports. Requests go through `connectors_http_request` (reqwest, OS
 * trust store) on Tauri, and fall back to `fetch` elsewhere so tests and any
 * future headless host keep working.
 *
 * Same `{status, headers, body}` shape as `lib/data/destinations/http.ts`;
 * kept separate because that module is scoped to the backup destinations'
 * settings and error handling.
 */

import { isTauri } from "@/lib/platform/detect"
import { connectorsHttpRequest } from "@/lib/connectors/tauri/commands"

export interface GoogleHttpRequest {
  url: string
  method: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
}

export interface GoogleHttpResponse {
  status: number
  headers: Record<string, string>
  body: string
}

export type GoogleHttpFn = (request: GoogleHttpRequest) => Promise<GoogleHttpResponse>

const DEFAULT_TIMEOUT_MS = 30_000

function lowerHeaders(
  headers: Iterable<[string, string]> | Record<string, unknown>
): Record<string, string> {
  const out: Record<string, string> = {}
  const entries: Iterable<[string, unknown]> =
    typeof (headers as Iterable<[string, string]>)[Symbol.iterator] === "function"
      ? (headers as Iterable<[string, string]>)
      : Object.entries(headers as Record<string, unknown>)
  for (const [k, v] of entries) out[k.toLowerCase()] = typeof v === "string" ? v : String(v)
  return out
}

async function fetchTransport(request: GoogleHttpRequest): Promise<GoogleHttpResponse> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: controller.signal,
    })
    return {
      status: response.status,
      headers: lowerHeaders(response.headers as unknown as Iterable<[string, string]>),
      body: await response.text(),
    }
  } finally {
    clearTimeout(timer)
  }
}

async function tauriTransport(request: GoogleHttpRequest): Promise<GoogleHttpResponse> {
  const response = await connectorsHttpRequest({
    url: request.url,
    method: request.method,
    headers: request.headers,
    body: request.body,
    timeoutMs: request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  })
  return {
    status: response.status,
    headers: lowerHeaders(response.headers ?? {}),
    body: response.body ?? "",
  }
}

/** Pick the transport for the local host. */
export function resolveGoogleHttp(): GoogleHttpFn {
  return isTauri() ? tauriTransport : fetchTransport
}

/** Run one request through the resolved transport. */
export function googleHttp(request: GoogleHttpRequest): Promise<GoogleHttpResponse> {
  return resolveGoogleHttp()(request)
}

/** Parse a JSON body defensively (returns `null` for non-JSON). */
export function parseJson<T>(body: string): T | null {
  if (!body) return null
  try {
    return JSON.parse(body) as T
  } catch {
    return null
  }
}
