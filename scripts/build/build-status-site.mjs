#!/usr/bin/env node
/**
 * Build the status-only static distribution from the app's static export.
 *
 * The public status page (`/status`, plan docs/plans/2026-10-02-signaling-
 * public-status-implementation.md §12) is served by the status Worker and by
 * the independent mirror. Neither may expose the rest of the application
 * export, so this script copies only what `/status` needs:
 *
 *   1. Static closure: every `/_next/static/…` reference in `status.html`
 *      (scripts, CSS, fonts, inline RSC payload), every `url()` in those
 *      stylesheets, and every literal chunk path inside the included scripts.
 *   2. Runtime closure: a headless Chromium loads the page from a local
 *      server over `out/` with schema-valid fixture data (`lib/status/
 *      fixtures.ts`), exercises every button, range, dialog and the incident
 *      deep link, and records each asset request — catching lazily loaded
 *      chunks the static scan cannot name.
 *
 * Output layout (consumed by `[assets]` in services/status-server/worker/
 * wrangler.toml and by the mirror's assetsDir):
 *   <dest>/status/index.html, <dest>/status.txt, <dest>/status/__next.*.txt,
 *   <dest>/_next/static/**, <dest>/status-asset-manifest.json
 *
 * The Worker injects the runtime `<meta>` at request time, so the HTML is
 * copied unmodified.
 *
 * Usage:
 *   node scripts/build/build-status-site.mjs [--out out] [--dest dir] [--no-crawl]
 */

import { createHash } from "node:crypto"
import { createServer } from "node:http"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = path.resolve(HERE, "..", "..")
export const DEFAULT_OUT = path.join(REPO_ROOT, "out")
export const DEFAULT_DEST = path.join(REPO_ROOT, "services", "status-server", "worker", "assets")
/** Cloudflare Workers static asset limits (per file / per deployment). */
export const MAX_ASSET_BYTES = 25 * 1024 * 1024
export const MAX_ASSET_FILES = 20_000
const RUNTIME_META = JSON.stringify({ mode: "primary", apiBase: "/api/status/v1" })
/** Mirrors INERT_SERVICE_WORKER in services/status-server/worker/src/assets.ts. */
const INERT_SERVICE_WORKER =
  'self.addEventListener("install", () => self.skipWaiting())\nself.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()))\n'

/** Root-level files the page may load besides `/_next/static` (never the app's own `/sw.js`). */
export function isRootPageFile(pathname) {
  return /^\/[A-Za-z0-9._-]+\.(?:js|ico|png|svg|webmanifest|json)$/.test(pathname) && pathname !== "/sw.js"
}

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".webp": "image/webp",
}

export function parseArgs(argv) {
  const options = { out: DEFAULT_OUT, dest: DEFAULT_DEST, crawl: true }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--out") options.out = path.resolve(argv[++index] ?? "")
    else if (arg === "--dest") options.dest = path.resolve(argv[++index] ?? "")
    else if (arg === "--no-crawl") options.crawl = false
    else throw new Error(`unknown option: ${arg}`)
  }
  return options
}

/** Normalise a reference to a `/_next/static/…` path without query/hash. */
export function normalizeStaticRef(ref) {
  let value = ref.replace(/\\u002F/gi, "/").replace(/\\\//g, "/")
  value = value.split(/[?#]/)[0]
  if (value.startsWith("static/")) value = `/_next/${value}`
  if (!value.startsWith("/_next/static/")) return null
  if (value.includes("..") || /["'\s\\<>]/.test(value)) return null
  return value
}

/** `/_next/static/…` references anywhere in HTML (attributes and inline RSC payload). */
export function collectHtmlRefs(html) {
  const refs = new Set()
  // Inline RSC payloads may escape slashes (`\u002F`, `\/`).
  const decoded = html.replace(/\\u002F/gi, "/").replace(/\\\//g, "/")
  for (const match of decoded.matchAll(/\/_next\/static\/[A-Za-z0-9_\-./@~%]+/g)) {
    const ref = normalizeStaticRef(match[0])
    if (ref) refs.add(ref)
  }
  return refs
}

/** Same-origin non-Next files the HTML links (favicon, manifest, icons). */
export function collectLocalLinks(html) {
  const links = new Set()
  for (const match of html.matchAll(/\b(?:href|src)="(\/[^"#?]+\.[A-Za-z0-9]{2,5})"/g)) {
    const value = match[1]
    if (!value.startsWith("/_next/") && !value.includes("..")) links.add(value)
  }
  return links
}

/** `url()` targets of a stylesheet, resolved against the stylesheet's path. */
export function collectCssRefs(css, cssPath) {
  const refs = new Set()
  for (const match of css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)) {
    const target = match[2]
    if (/^(data:|https?:|#)/.test(target)) continue
    const resolved = target.startsWith("/") ? target : path.posix.join(path.posix.dirname(cssPath), target)
    const ref = normalizeStaticRef(resolved)
    if (ref) refs.add(ref)
  }
  return refs
}

/** Fully literal chunk/media/css paths inside a script (no concatenation). */
export function collectScriptRefs(js) {
  const refs = new Set()
  for (const match of js.matchAll(/["'`](?:\/_next\/)?(static\/(?:chunks|css|media)\/[A-Za-z0-9_\-./@]+\.(?:js|css|woff2?|ttf|png|svg|webp|avif))["'`]/g)) {
    const ref = normalizeStaticRef(match[1])
    if (ref) refs.add(ref)
  }
  return refs
}

function fileFor(outDir, ref) {
  return path.join(outDir, ref.replace(/^\//, ""))
}

/** Static closure: HTML → CSS/scripts → their literal references, to a fixed point. */
export function staticClosure(outDir, html) {
  const refs = collectHtmlRefs(html)
  const queue = [...refs]
  while (queue.length > 0) {
    const ref = queue.pop()
    const file = fileFor(outDir, ref)
    if (!existsSync(file)) continue
    let found = new Set()
    if (ref.endsWith(".css")) found = collectCssRefs(readFileSync(file, "utf8"), ref)
    else if (ref.endsWith(".js")) found = collectScriptRefs(readFileSync(file, "utf8"))
    for (const next of found) {
      if (!refs.has(next)) {
        refs.add(next)
        queue.push(next)
      }
    }
  }
  return refs
}

/** Find the exported status HTML: `status.html` (trailingSlash false) or `status/index.html`. */
export function locateStatusHtml(outDir) {
  for (const candidate of ["status.html", path.join("status", "index.html")]) {
    const file = path.join(outDir, candidate)
    if (existsSync(file)) return file
  }
  throw new Error(`no exported status page in ${outDir} (expected status.html or status/index.html)`)
}

async function loadFixtures() {
  const esbuild = await import("esbuild")
  const dir = mkdtempSync(path.join(tmpdir(), "status-fixtures-"))
  const outfile = path.join(dir, "fixtures.mjs")
  await esbuild.build({
    entryPoints: [path.join(REPO_ROOT, "lib", "status", "fixtures.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile,
    logLevel: "silent",
  })
  try {
    return await import(pathToFileURL(outfile).href)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Local server over `out/` that mimics the status Worker's routing and API. */
function startCrawlServer(outDir, statusHtml, fixtures, requested) {
  const now = Date.now()
  const snapshot = (range) => {
    const body = fixtures.createStatusFixture("major_outage", range)
    // Fresh timestamps so the page renders as live rather than stale.
    return { ...body, generatedAt: new Date(now).toISOString(), serverTime: new Date(now).toISOString() }
  }
  const html = statusHtml.replace(
    /<head>/,
    `<head><meta name="cognia-status-runtime" content='${RUNTIME_META}'>`
  )
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    requested.add(url.pathname)
    const send = (status, type, body) => {
      response.writeHead(status, { "content-type": type })
      response.end(body)
    }
    if (url.pathname.startsWith("/api/status/v1/")) {
      const api = url.pathname.slice("/api/status/v1".length)
      if (api === "/snapshot") {
        return send(200, CONTENT_TYPES[".json"], JSON.stringify(snapshot(url.searchParams.get("range") ?? "90d")))
      }
      if (api === "/incidents") {
        return send(200, CONTENT_TYPES[".json"], JSON.stringify({ schemaVersion: 1, incidents: [fixtures.FIXTURE_PAST_INCIDENT], nextCursor: null }))
      }
      if (api.startsWith("/incidents/")) {
        const incident = { ...fixtures.FIXTURE_ACTIVE_INCIDENT, updates: [fixtures.FIXTURE_ACTIVE_INCIDENT.latestUpdate] }
        return send(200, CONTENT_TYPES[".json"], JSON.stringify({ schemaVersion: 1, incident }))
      }
      return send(400, CONTENT_TYPES[".json"], JSON.stringify({ code: "token_invalid", requestId: "crawl" }))
    }
    if (url.pathname === "/status/" || url.pathname === "/status") return send(200, CONTENT_TYPES[".html"], html)
    // Production serves an inert worker here (services/status-server/worker/
    // src/assets.ts), never the app's precaching one.
    if (url.pathname === "/sw.js") return send(200, CONTENT_TYPES[".js"], INERT_SERVICE_WORKER)
    const file = path.join(outDir, decodeURIComponent(url.pathname).replace(/^\//, ""))
    if (!file.startsWith(outDir) || !existsSync(file) || !statSync(file).isFile()) {
      return send(404, "text/plain", "not found")
    }
    return send(200, CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream", readFileSync(file))
  })
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server))
  })
}

/**
 * Load the page in Chromium and exercise it so lazily loaded chunks are
 * requested. Returns every `/_next/static/…` path the browser asked for and
 * any page errors.
 */
export async function crawlStatusPage(outDir, statusHtml) {
  const { chromium } = await import("@playwright/test")
  const fixtures = await loadFixtures()
  const requested = new Set()
  const server = await startCrawlServer(outDir, statusHtml, fixtures, requested)
  const { port } = server.address()
  const base = `http://127.0.0.1:${port}`
  const browser = await chromium.launch()
  const errors = []
  // Only what the page itself loads belongs to the status site. The status
  // host does not serve the app's PWA service worker (`/sw.js`), so the crawl
  // server answers it 404 exactly as production does; requests a worker would
  // make are never attributed to the page.
  const pageRequests = new Set()
  try {
    for (const viewport of [
      { width: 1280, height: 900 },
      { width: 390, height: 844 },
    ]) {
      const context = await browser.newContext({ viewport })
      const page = await context.newPage()
      page.on("request", (request) => pageRequests.add(new URL(request.url()).pathname))
      page.on("pageerror", (error) => errors.push(String(error)))
      await page.goto(`${base}/status/`, { waitUntil: "networkidle" })
      // Click every control once; dialogs are dismissed with Escape.
      const controls = await page.locator("main button, main [role=radio], main [role=tab], header button").all()
      for (const control of controls) {
        if (!(await control.isVisible().catch(() => false))) continue
        await control.click({ timeout: 2_000 }).catch(() => {})
        await page.waitForTimeout(150)
        await page.keyboard.press("Escape").catch(() => {})
      }
      await page.goto(`${base}/status/?incident=${fixtures.FIXTURE_ACTIVE_INCIDENT.id}`, { waitUntil: "networkidle" })
      await page.goto(`${base}/status/#action=manage&token=${"a".repeat(43)}`, { waitUntil: "networkidle" })
      await page.waitForTimeout(300)
      await context.close()
    }
  } finally {
    await browser.close()
    await new Promise((resolve) => server.close(resolve))
  }
  const assets = new Set()
  const rootFiles = new Set()
  for (const pathname of pageRequests) {
    const ref = normalizeStaticRef(pathname)
    if (ref) assets.add(ref)
    else if (isRootPageFile(pathname) && existsSync(path.join(outDir, pathname.slice(1)))) {
      rootFiles.add(pathname)
    }
  }
  return { assets, rootFiles, errors }
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex")
}

function copyInto(outDir, dest, relative) {
  const from = path.join(outDir, relative)
  const to = path.join(dest, relative)
  mkdirSync(path.dirname(to), { recursive: true })
  copyFileSync(from, to)
  return to
}

function clearDest(dest) {
  mkdirSync(dest, { recursive: true })
  for (const entry of readdirSync(dest)) {
    if (entry === ".gitkeep") continue
    rmSync(path.join(dest, entry), { recursive: true, force: true })
  }
}

export async function buildStatusSite(options) {
  const { out, dest } = options
  const htmlFile = locateStatusHtml(out)
  const html = readFileSync(htmlFile, "utf8")
  const refs = staticClosure(out, html)
  let crawled = { assets: new Set(), rootFiles: new Set(), errors: [] }
  if (options.crawl) {
    crawled = await crawlStatusPage(out, html)
    if (crawled.errors.length > 0) {
      throw new Error(`status page raised errors during the crawl:\n${crawled.errors.join("\n")}`)
    }
    for (const ref of crawled.assets) refs.add(ref)
  }
  const missing = [...refs].filter((ref) => !existsSync(fileFor(out, ref)))
  // A reference the browser actually requested must exist; a literal found
  // only by the static scan may name a chunk of another build (ignored).
  const missingRequested = missing.filter((ref) => crawled.assets.has(ref) || collectHtmlRefs(html).has(ref))
  if (missingRequested.length > 0) {
    throw new Error(`status page references missing assets:\n${missingRequested.join("\n")}`)
  }

  clearDest(dest)
  const files = []
  const record = (relative) => {
    const file = copyInto(out, dest, relative)
    const bytes = statSync(file).size
    if (bytes > MAX_ASSET_BYTES) throw new Error(`asset exceeds the Workers per-file limit: ${relative}`)
    files.push({ path: `/${relative.split(path.sep).join("/")}`, bytes, sha256: sha256(file) })
  }
  // The page itself at /status/ (index.html) for the Worker's asset routing.
  const indexTarget = path.join(dest, "status", "index.html")
  mkdirSync(path.dirname(indexTarget), { recursive: true })
  copyFileSync(htmlFile, indexTarget)
  files.push({ path: "/status/index.html", bytes: statSync(indexTarget).size, sha256: sha256(indexTarget) })
  // RSC payloads for client-side navigation within the route.
  if (existsSync(path.join(out, "status.txt"))) record("status.txt")
  const rscDir = path.join(out, "status")
  if (existsSync(rscDir)) {
    for (const entry of readdirSync(rscDir)) {
      if (entry.startsWith("__next.") && entry.endsWith(".txt")) record(path.join("status", entry))
    }
  }
  for (const file of crawled.rootFiles) record(file.slice(1))
  for (const link of collectLocalLinks(html)) {
    if (existsSync(path.join(out, link.slice(1)))) record(link.slice(1))
  }
  for (const ref of [...refs].sort()) {
    if (existsSync(fileFor(out, ref))) record(ref.slice(1))
  }
  if (files.length > MAX_ASSET_FILES) throw new Error(`too many assets for one Worker deployment: ${files.length}`)

  const buildId = readdirSync(path.join(out, "_next", "static")).find((entry) =>
    existsSync(path.join(out, "_next", "static", entry, "_buildManifest.js"))
  )
  const manifest = {
    generatedAt: new Date().toISOString(),
    buildId: buildId ?? null,
    crawl: options.crawl,
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    files,
  }
  writeFileSync(path.join(dest, "status-asset-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const manifest = await buildStatusSite(options)
  console.log(
    `status site: ${manifest.fileCount} files, ${(manifest.totalBytes / 1024 / 1024).toFixed(2)} MiB → ${path.relative(REPO_ROOT, options.dest)}`
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
