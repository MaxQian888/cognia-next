/**
 * The read-only mirror's HTTP surface (plan §12). Behind Caddy (TLS) on an
 * independent host and DNS name. It serves only:
 *   - `/` → 302 `/status/`
 *   - the exported status-only site, with the mirror runtime `<meta>` injected
 *   - `GET /api/status/v1/{snapshot,healthz,feed.atom,feed.rss}` from the
 *     last validated copies
 * Incidents answer 503 (no incident API on a mirror); every other `/api`
 * path is a JSON 404; every non-GET/HEAD is a JSON 405. There is no signup,
 * admin or ingest route to expose.
 */

import { randomUUID } from "node:crypto"
import { readFile, realpath, stat } from "node:fs/promises"
import http from "node:http"
import path from "node:path"

import { HISTORY_RANGES, type HistoryRange } from "../../../../../../lib/status/contract"
import { STATUS_API_PATH } from "../../../../../../lib/status/config"

import type { Logger } from "../logger"
import { injectRuntimeMeta } from "./html"
import { MIRROR_RESOURCES, readSyncState } from "./sync"

export const MIRROR_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  "object-src 'none'",
].join("; ")

const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": MIRROR_CSP,
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()",
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".xml": "application/xml; charset=utf-8",
}

export interface MirrorServerOptions {
  assetsDir: string
  dataDir: string
  logger: Logger
}

type Layout = { kind: "dir"; html: string } | { kind: "file"; html: string } | null

/** Detect how the export emitted the page: `status/index.html` or `status.html`. */
async function detectLayout(root: string): Promise<Layout> {
  const dirIndex = path.join(root, "status", "index.html")
  if (await isFile(dirIndex)) return { kind: "dir", html: dirIndex }
  const flat = path.join(root, "status.html")
  if (await isFile(flat)) return { kind: "file", html: flat }
  return null
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile()
  } catch {
    return false
  }
}

/**
 * Resolve a URL path inside `root`, or null. Rejects encoded traversal,
 * dot-segments, hidden files, NUL bytes and symlinks that leave the root.
 */
export async function resolveStaticPath(
  assetsRoot: string,
  urlPath: string
): Promise<string | null> {
  let root: string
  try {
    // Compare canonical paths only (macOS /var → /private/var, release symlinks).
    root = await realpath(assetsRoot)
  } catch {
    return null
  }
  let decoded: string
  try {
    decoded = decodeURIComponent(urlPath)
  } catch {
    return null
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null
  const segments = decoded.split("/").filter((segment) => segment !== "")
  if (segments.some((segment) => segment === "." || segment === ".." || segment.startsWith(".")))
    return null
  const candidate = path.resolve(root, ...segments)
  if (candidate !== root && !candidate.startsWith(root + path.sep)) return null
  let real: string
  try {
    real = await realpath(candidate)
  } catch {
    return null
  }
  if (real !== root && !real.startsWith(root + path.sep)) return null
  try {
    const info = await stat(real)
    if (info.isDirectory()) {
      const index = path.join(real, "index.html")
      return (await isFile(index)) ? index : null
    }
    return info.isFile() ? real : null
  } catch {
    return null
  }
}

function snapshotFile(range: HistoryRange): string {
  return MIRROR_RESOURCES.find((resource) => resource.range === range)!.file
}

export function createMirrorServer(options: MirrorServerOptions): http.Server {
  return http.createServer((req, res) => {
    const requestId = randomUUID()
    handle(req, res, requestId, options).catch(() => {
      if (!res.headersSent) sendJson(res, req, 500, { code: "internal", requestId })
      else res.destroy()
      options.logger.error("mirror_request_failed", { requestId })
    })
  })
}

function baseHeaders(res: http.ServerResponse, requestId: string): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value)
  res.setHeader("x-request-id", requestId)
  res.setHeader("x-cognia-status-mode", "mirror")
}

function sendBody(
  res: http.ServerResponse,
  req: http.IncomingMessage,
  status: number,
  contentType: string,
  body: string | Uint8Array,
  extra: Record<string, string> = {}
): void {
  const bytes = typeof body === "string" ? Buffer.from(body, "utf8") : body
  res.statusCode = status
  res.setHeader("content-type", contentType)
  res.setHeader("content-length", String(bytes.byteLength))
  for (const [name, value] of Object.entries(extra)) res.setHeader(name, value)
  res.end(req.method === "HEAD" ? undefined : bytes)
}

function sendJson(
  res: http.ServerResponse,
  req: http.IncomingMessage,
  status: number,
  body: unknown,
  extra: Record<string, string> = {}
): void {
  sendBody(res, req, status, "application/json; charset=utf-8", JSON.stringify(body), {
    "cache-control": "no-store",
    ...extra,
  })
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  requestId: string,
  options: MirrorServerOptions
): Promise<void> {
  baseHeaders(res, requestId)
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendJson(res, req, 405, { code: "method_not_allowed", requestId }, { allow: "GET, HEAD" })
    return
  }
  let url: URL
  try {
    url = new URL(req.url ?? "/", "http://mirror.invalid")
  } catch {
    sendJson(res, req, 400, { code: "bad_request", requestId })
    return
  }
  const pathname = url.pathname
  if (pathname === "/") {
    res.statusCode = 302
    res.setHeader("location", "/status/")
    res.setHeader("cache-control", "no-store")
    res.end()
    return
  }
  if (pathname === "/api" || pathname.startsWith("/api/")) {
    await handleApi(req, res, url, requestId, options)
    return
  }
  await handleStatic(req, res, pathname, options)
}

async function handleApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  requestId: string,
  options: MirrorServerOptions
): Promise<void> {
  const route = url.pathname.startsWith(`${STATUS_API_PATH}/`)
    ? url.pathname.slice(STATUS_API_PATH.length)
    : null
  if (route === "/snapshot") {
    const range = url.searchParams.get("range") ?? "24h"
    if (!(HISTORY_RANGES as readonly string[]).includes(range)) {
      sendJson(res, req, 400, { code: "bad_request", requestId })
      return
    }
    const body = await readData(options.dataDir, snapshotFile(range as HistoryRange))
    if (!body) {
      sendJson(res, req, 404, { code: "unavailable", requestId })
      return
    }
    sendBody(res, req, 200, "application/json; charset=utf-8", body, {
      "cache-control": "public, max-age=30",
    })
    return
  }
  if (route === "/healthz") {
    const state = await readSyncState(options.dataDir)
    sendJson(res, req, 200, {
      ok: true,
      mode: "mirror",
      lastSyncAt: state.lastSyncAt,
      lastSyncOk: state.lastSyncOk,
    })
    return
  }
  if (route === "/feed.atom" || route === "/feed.rss") {
    const resource = MIRROR_RESOURCES.find((entry) => entry.apiPath === route)!
    const body = await readData(options.dataDir, resource.file)
    if (!body) {
      sendJson(res, req, 404, { code: "unavailable", requestId })
      return
    }
    sendBody(res, req, 200, resource.contentType, body, { "cache-control": "public, max-age=60" })
    return
  }
  if (route === "/incidents" || route?.startsWith("/incidents/")) {
    // Incident history is in the snapshot; the paginated API is primary-only.
    sendJson(res, req, 503, { code: "unavailable", requestId })
    return
  }
  sendJson(res, req, 404, { code: "not_found", requestId })
}

async function readData(dataDir: string, file: string): Promise<Uint8Array | null> {
  try {
    return await readFile(path.join(dataDir, file))
  } catch {
    return null
  }
}

async function handleStatic(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  options: MirrorServerOptions
): Promise<void> {
  // Re-resolve per request so an atomic `current` symlink swap takes effect
  // immediately and an in-flight request keeps a consistent release.
  let root: string
  try {
    root = await realpath(options.assetsDir)
  } catch {
    sendBody(res, req, 503, "text/plain; charset=utf-8", "Status assets unavailable\n", {
      "cache-control": "no-store",
    })
    return
  }
  const layout = await detectLayout(root)
  if (layout) {
    if (pathname === "/status" && layout.kind === "dir") {
      res.statusCode = 308
      res.setHeader("location", "/status/")
      res.end()
      return
    }
    const isPage =
      pathname === "/status/" ||
      pathname === "/status/index.html" ||
      pathname === "/status.html" ||
      (pathname === "/status" && layout.kind === "file")
    if (isPage) {
      await sendHtml(req, res, layout.html)
      return
    }
  }
  const file = await resolveStaticPath(root, pathname)
  if (!file) {
    sendBody(res, req, 404, "text/plain; charset=utf-8", "Not found\n", {
      "cache-control": "no-store",
    })
    return
  }
  if (file.endsWith(".html")) {
    await sendHtml(req, res, file)
    return
  }
  const type = CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream"
  const cache = pathname.startsWith("/_next/static/")
    ? "public, max-age=31536000, immutable"
    : "public, max-age=300"
  sendBody(res, req, 200, type, await readFile(file), { "cache-control": cache })
}

async function sendHtml(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  file: string
): Promise<void> {
  const html = injectRuntimeMeta(await readFile(file, "utf8"))
  sendBody(res, req, 200, "text/html; charset=utf-8", html, { "cache-control": "no-cache" })
}
