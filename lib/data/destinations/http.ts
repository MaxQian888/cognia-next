/**
 * Host-neutral HTTP for the remote backup destinations (GitHub / Google).
 *
 *   - Tauri desktop → `connectors_http_request` (reqwest) so the WebView's
 *     CORS policy never gets in the way and TLS is the OS trust store;
 *   - every other host (the headless brain, tests) → global `fetch`.
 *
 * Bodies are text (the encrypted envelope is JSON; multipart uploads are
 * text parts), so a single `{status, headers, body}` shape covers both paths.
 */

import { isTauri } from "@/lib/platform/detect"
import { connectorsHttpRequest } from "@/lib/connectors/tauri/commands"

export interface BackupHttpRequest {
  url: string
  method: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
}

export interface BackupHttpResponse {
  status: number
  headers: Record<string, string>
  body: string
}

export type BackupHttpFn = (request: BackupHttpRequest) => Promise<BackupHttpResponse>

const DEFAULT_TIMEOUT_MS = 60_000

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

async function fetchTransport(request: BackupHttpRequest): Promise<BackupHttpResponse> {
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

async function tauriTransport(request: BackupHttpRequest): Promise<BackupHttpResponse> {
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
export function resolveBackupHttp(): BackupHttpFn {
  return isTauri() ? tauriTransport : fetchTransport
}

/** Convenience: run one request through the resolved transport. */
export function backupHttpRequest(request: BackupHttpRequest): Promise<BackupHttpResponse> {
  return resolveBackupHttp()(request)
}

/** Parse a JSON body defensively (returns `null` for non-JSON). */
export function parseJsonBody<T>(body: string): T | null {
  if (!body) return null
  try {
    return JSON.parse(body) as T
  } catch {
    return null
  }
}

/** UTF-8 → base64 (GitHub contents API expects base64 file content). */
export function toBase64Utf8(text: string): string {
  if (typeof Buffer !== "undefined") return Buffer.from(text, "utf8").toString("base64")
  const bytes = new TextEncoder().encode(text)
  let binary = ""
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}
