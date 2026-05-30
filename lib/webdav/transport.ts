"use client"

// Platform-routed HTTP transport for the WebDAV client.
//
//   - Mobile (Capacitor native): CapacitorHttp.request — bypasses the WebView
//     CORS/interceptor and supports `serverTrustMode: "self-signed"`.
//   - Desktop (Tauri): connectors_http_request (reqwest) — bypasses CORS and
//     accepts arbitrary WebDAV methods.
//   - Web: throws. Self-hosted WebDAV servers almost never send CORS headers,
//     so a browser fetch would be blocked; WebDAV sync is desktop/mobile only.

import { isTauri } from "@/lib/tauri"
import { getCapacitorHttp } from "@/lib/connectivity/capacitor-http"
import { connectorsHttpRequest } from "@/lib/connectors/tauri/commands"
import { WebDavError } from "./errors"
import type { WebDavRequest, WebDavResponse, WebDavTransport } from "./types"

const DEFAULT_TIMEOUT_MS = 30_000

function normalizeHeaders(headers: unknown): Record<string, string> {
  if (!headers || typeof headers !== "object") return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    out[k.toLowerCase()] = typeof v === "string" ? v : String(v)
  }
  return out
}

function dataToString(data: unknown): string {
  if (data == null) return ""
  if (typeof data === "string") return data
  // CapacitorHttp may auto-parse JSON-looking bodies into objects; multistatus
  // is XML so this rarely fires, but stringify defensively.
  try {
    return JSON.stringify(data)
  } catch {
    return String(data)
  }
}

/** Transport over the Tauri reqwest bridge. */
class TauriHttpTransport implements WebDavTransport {
  async send(req: WebDavRequest): Promise<WebDavResponse> {
    const resp = await connectorsHttpRequest({
      url: req.url,
      method: req.method,
      headers: req.headers,
      body: req.body,
      timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    })
    return {
      status: resp.status,
      headers: normalizeHeaders(resp.headers),
      body: resp.body,
    }
  }
}

/** Transport over CapacitorHttp (native iOS/Android). */
class CapacitorHttpTransport implements WebDavTransport {
  constructor(private readonly trustSelfSigned: boolean) {}

  async send(req: WebDavRequest): Promise<WebDavResponse> {
    const cap = getCapacitorHttp()
    if (!cap) throw new WebDavError("CapacitorHttp is unavailable", 0)
    const timeout = req.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const resp = await cap.request({
      url: req.url,
      method: req.method,
      headers: req.headers,
      data: req.body,
      serverTrustMode: this.trustSelfSigned ? "self-signed" : "default",
      connectTimeout: timeout,
      readTimeout: timeout,
      responseType: "text",
    })
    return {
      status: resp.status,
      headers: normalizeHeaders(resp.headers),
      body: dataToString(resp.data),
    }
  }
}

export interface CreateTransportOptions {
  /** Allow self-signed certs (self-hosted servers on LAN). Default false. */
  trustSelfSigned?: boolean
}

/**
 * Pick a transport for the current platform. Throws on web — callers should
 * gate the WebDAV feature on desktop/mobile before reaching here.
 */
export function createWebDavTransport(opts: CreateTransportOptions = {}): WebDavTransport {
  if (getCapacitorHttp()) {
    return new CapacitorHttpTransport(opts.trustSelfSigned ?? false)
  }
  if (isTauri()) {
    return new TauriHttpTransport()
  }
  throw new WebDavError("WebDAV is only available in the desktop or mobile app", 0)
}

/**
 * Whether WebDAV requests can be made on this platform. False on web, where a
 * self-hosted server's missing CORS headers would block a browser fetch. UI
 * uses this to disable connect/sync/restore and show a "desktop/mobile only"
 * note rather than letting those actions fail with a transport error.
 */
export function isWebDavSupported(): boolean {
  return Boolean(getCapacitorHttp()) || isTauri()
}
