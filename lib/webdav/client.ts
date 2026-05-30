// Minimal WebDAV client: just the verbs snapshot sync needs (PUT/GET/PROPFIND/
// MKCOL/DELETE/exists). The transport is injected so tests pass a fake and
// the platform routing lives entirely in `transport.ts`.

import { WebDavError, WebDavNotFoundError, WebDavAuthError } from "./errors"
import { parseMultiStatus } from "./propfind"
import { createWebDavTransport, type CreateTransportOptions } from "./transport"
import type { WebDavCredentials, WebDavEntry, WebDavRequest, WebDavTransport } from "./types"

// Request body for a PROPFIND that fetches the props we care about.
const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<D:propfind xmlns:D="DAV:"><D:prop>' +
  "<D:getlastmodified/><D:getcontentlength/><D:resourcetype/><D:getetag/>" +
  "</D:prop></D:propfind>"

function encodeBasicAuth(username: string, password: string): string {
  const raw = `${username}:${password}`
  if (typeof btoa === "function") {
    // btoa needs a binary string; encode UTF-8 first.
    const utf8 = new TextEncoder().encode(raw)
    let binary = ""
    for (const byte of utf8) binary += String.fromCharCode(byte)
    return btoa(binary)
  }
  return Buffer.from(raw, "utf-8").toString("base64")
}

/** Percent-encode each path segment, preserving slashes. */
function encodePath(path: string): string {
  return path
    .split("/")
    .map((seg) => (seg ? encodeURIComponent(seg) : seg))
    .join("/")
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300
}

export class WebDavClient {
  private readonly baseUrl: string
  private readonly auth: string

  constructor(
    creds: WebDavCredentials,
    private readonly transport: WebDavTransport
  ) {
    this.baseUrl = creds.baseUrl.replace(/\/+$/, "")
    this.auth = `Basic ${encodeBasicAuth(creds.username, creds.password)}`
  }

  private url(path: string): string {
    const normalized = path.startsWith("/") ? path : `/${path}`
    return `${this.baseUrl}${encodePath(normalized)}`
  }

  private async send(req: Omit<WebDavRequest, "headers"> & { headers?: Record<string, string> }) {
    return this.transport.send({
      ...req,
      headers: { Authorization: this.auth, ...(req.headers ?? {}) },
    })
  }

  private raiseFor(status: number, action: string): never {
    if (status === 401 || status === 403) {
      throw new WebDavAuthError(`WebDAV ${action} unauthorized (${status})`, status)
    }
    if (status === 404) {
      throw new WebDavNotFoundError(`WebDAV ${action} not found`)
    }
    throw new WebDavError(`WebDAV ${action} failed (${status})`, status)
  }

  /** Upload a file, overwriting if present. */
  async putFile(path: string, body: string): Promise<void> {
    const resp = await this.send({
      method: "PUT",
      url: this.url(path),
      headers: { "Content-Type": "application/octet-stream" },
      body,
    })
    if (!isSuccess(resp.status)) this.raiseFor(resp.status, "PUT")
  }

  /** Download a file. Throws `WebDavNotFoundError` on 404. */
  async getFile(path: string): Promise<string> {
    const resp = await this.send({ method: "GET", url: this.url(path) })
    if (!isSuccess(resp.status)) this.raiseFor(resp.status, "GET")
    return resp.body
  }

  /** Create a collection. Idempotent — a 405/301 ("already exists") is fine. */
  async ensureCollection(path: string): Promise<void> {
    const resp = await this.send({ method: "MKCOL", url: this.url(path) })
    // 201 created; 405 method-not-allowed + 301 moved both mean it exists.
    if (resp.status === 201 || resp.status === 405 || resp.status === 301) return
    if (isSuccess(resp.status)) return
    this.raiseFor(resp.status, "MKCOL")
  }

  /** List a collection (PROPFIND Depth:1). Includes the collection itself. */
  async propfindList(path: string, depth: 0 | 1 = 1): Promise<WebDavEntry[]> {
    const resp = await this.send({
      method: "PROPFIND",
      url: this.url(path),
      headers: { Depth: String(depth), "Content-Type": "application/xml" },
      body: PROPFIND_BODY,
    })
    if (resp.status === 404) throw new WebDavNotFoundError("WebDAV PROPFIND not found")
    if (resp.status !== 207 && !isSuccess(resp.status)) this.raiseFor(resp.status, "PROPFIND")
    return parseMultiStatus(resp.body)
  }

  /** Read the last-modified time (epoch ms) of a single resource, or null. */
  async lastModified(path: string): Promise<number | null> {
    const resp = await this.send({
      method: "PROPFIND",
      url: this.url(path),
      headers: { Depth: "0", "Content-Type": "application/xml" },
      body: PROPFIND_BODY,
    })
    if (resp.status === 404) return null
    if (resp.status !== 207 && !isSuccess(resp.status)) this.raiseFor(resp.status, "PROPFIND")
    const entries = parseMultiStatus(resp.body)
    return entries[0]?.lastModified ?? null
  }

  /** Delete a file. A 404 is treated as success (already gone). */
  async deleteFile(path: string): Promise<void> {
    const resp = await this.send({ method: "DELETE", url: this.url(path) })
    if (resp.status === 404 || isSuccess(resp.status)) return
    this.raiseFor(resp.status, "DELETE")
  }
}

/** Build a client wired to the platform transport. */
export function createWebDavClient(
  creds: WebDavCredentials,
  opts?: CreateTransportOptions
): WebDavClient {
  return new WebDavClient(creds, createWebDavTransport(opts))
}
