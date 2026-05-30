// Shared contracts for the WebDAV client. The transport is pluggable so the
// same protocol code runs over the Tauri reqwest bridge (desktop) and
// CapacitorHttp (mobile), and tests can inject a fake.

/** Connection details for a WebDAV server. */
export interface WebDavCredentials {
  /** Base URL with no trailing slash, e.g. `https://dav.example.com`. */
  baseUrl: string
  username: string
  password: string
}

/** A single entry returned by a PROPFIND listing. */
export interface WebDavEntry {
  /** Server-decoded path (the `<href>` value, percent-decoded). */
  href: string
  /** Basename of the href (no trailing slash). */
  name: string
  isCollection: boolean
  /** Bytes, from `getcontentlength` when present. */
  size?: number
  /** Epoch ms parsed from `getlastmodified` when present. */
  lastModified?: number
  etag?: string
}

export type WebDavMethod = "GET" | "PUT" | "DELETE" | "MKCOL" | "PROPFIND" | "HEAD" | "OPTIONS"

export interface WebDavRequest {
  method: WebDavMethod
  url: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
}

export interface WebDavResponse {
  status: number
  headers: Record<string, string>
  body: string
}

/**
 * Minimal HTTP transport the client drives. Implementations bypass CORS
 * (reqwest on desktop, CapacitorHttp on mobile). A throwing/error transport
 * is the right shape for unsupported platforms (web).
 */
export interface WebDavTransport {
  send(req: WebDavRequest): Promise<WebDavResponse>
}
