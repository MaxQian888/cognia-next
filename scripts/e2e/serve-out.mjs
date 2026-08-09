#!/usr/bin/env node
/**
 * Static server for the Next.js export (`out/`) used by the Playwright E2E
 * suite (`PLAYWRIGHT_STATIC=1`).
 *
 * Why not `pnpm dev`: under Turbopack dev the first hit of each route
 * compiles on demand (up to ~30s), so E2E timings measure the dev compiler,
 * not the app. Serving the prebuilt static export removes that entirely and
 * lets the Playwright test timeout drop back to its default.
 *
 * Resolution mirrors Next.js `output: "export"` semantics with
 * `trailingSlash: false`:
 *   /            → out/index.html
 *   /goals       → out/goals.html   (extensionless routes gain .html)
 *   /goals/      → out/goals/index.html, falling back to out/goals.html
 *   /_next/...   → exact static asset
 *   anything else → out/404.html with status 404
 *
 * The export must be built with `NEXT_PUBLIC_E2E=1` (the test-globals bridge
 * is dead-code-eliminated otherwise and every spec would time out waiting
 * for `window.__cogniaResetDb`). On startup the server greps the exported
 * chunks for that marker and refuses to start when it is missing — override
 * with --skip-e2e-marker-check for non-E2E use of this server.
 *
 * Usage:
 *   node scripts/e2e/serve-out.mjs [--port 3000] [--host 127.0.0.1]
 *     [--root out] [--skip-e2e-marker-check]
 */

import { createServer } from "node:http"
import { promises as fs } from "node:fs"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Command, CommanderError } from "commander"
import { z } from "zod"

/** Marker string the E2E bridge hangs off `window`; survives minification. */
export const E2E_MARKER = "__cogniaResetDb"

const CONTENT_TYPES = {
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
  ".wasm": "application/wasm",
  ".map": "application/json",
  ".webmanifest": "application/manifest+json",
  ".xml": "application/xml",
  ".pdf": "application/pdf",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".data": "application/octet-stream",
  ".bin": "application/octet-stream",
  ".moc3": "application/octet-stream",
}

export function contentTypeFor(filePath) {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream"
}

/**
 * Map a request pathname onto a file inside `root` using static-export
 * semantics. Returns `{ file, status }` — `file` is an absolute path or
 * `null` when nothing matches (the caller then serves 404.html). Never
 * resolves outside `root` (traversal attempts are treated as a miss).
 */
export async function resolveFilePath(root, rawPathname) {
  let pathname
  try {
    pathname = decodeURIComponent(rawPathname)
  } catch {
    return null
  }
  // Normalize and confine to the export root. `path.resolve` collapses any
  // `..` segments; requests escaping the root are rejected outright.
  const absRoot = path.resolve(root)
  const joined = path.resolve(absRoot, "." + path.posix.normalize("/" + pathname))
  if (joined !== absRoot && !joined.startsWith(absRoot + path.sep)) return null

  const statOf = async (p) => {
    try {
      return await fs.stat(p)
    } catch {
      return null
    }
  }

  const direct = await statOf(joined)
  if (direct?.isFile()) return joined
  if (direct?.isDirectory()) {
    const index = path.join(joined, "index.html")
    if ((await statOf(index))?.isFile()) return index
  }
  // Extensionless route → sibling .html (Next export with trailingSlash:false).
  if (!path.extname(joined)) {
    const html = joined.replace(/[/\\]+$/, "") + ".html"
    if (html.startsWith(absRoot) && (await statOf(html))?.isFile()) return html
  }
  return null
}

/**
 * Scan the exported client chunks for the E2E bridge marker. Returns true
 * when the marker is present (the export was built with NEXT_PUBLIC_E2E=1).
 */
export function exportHasE2eMarker(root) {
  const chunksDir = path.join(root, "_next", "static", "chunks")
  if (!existsSync(chunksDir)) return false
  const stack = [chunksDir]
  while (stack.length > 0) {
    const dir = stack.pop()
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.isFile() && /\.(js|mjs)$/.test(entry.name)) {
        if (readFileSync(full, "utf8").includes(E2E_MARKER)) return true
      }
    }
  }
  return false
}

/** Create (but do not bind) the HTTP server for a static export at `root`. */
export function createOutServer(root) {
  const absRoot = path.resolve(root)
  return createServer(async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD" })
      res.end()
      return
    }
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname
    let file = await resolveFilePath(absRoot, pathname)
    let status = 200
    if (!file) {
      status = 404
      const notFound = path.join(absRoot, "404.html")
      file = existsSync(notFound) ? notFound : null
    }
    if (!file) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" })
      res.end("Not Found")
      return
    }
    try {
      const body = await fs.readFile(file)
      res.writeHead(status, {
        "Content-Type": contentTypeFor(file),
        "Content-Length": body.byteLength,
        // Fresh browser contexts per test make cross-run caching moot; keep
        // responses uncacheable so a rebuilt out/ is always what gets served.
        "Cache-Control": "no-store",
      })
      res.end(req.method === "HEAD" ? undefined : body)
    } catch {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" })
      res.end("Internal Server Error")
    }
  })
}

const cliSchema = z.object({
  host: z.string().trim().min(1, "--host must not be empty").default("127.0.0.1"),
  port: z.coerce
    .number({ error: "--port must be an integer between 0 and 65535" })
    .int("--port must be an integer between 0 and 65535")
    .min(0, "--port must be an integer between 0 and 65535")
    .max(65_535, "--port must be an integer between 0 and 65535")
    .default(3000),
  root: z.string().trim().min(1, "--root must not be empty").default("out"),
  skipMarkerCheck: z.boolean().default(false),
})

function createProgram() {
  return new Command()
    .name("node scripts/e2e/serve-out.mjs")
    .description("Serve Cognia's static export for Playwright E2E runs.")
    .configureOutput({ writeErr: () => {} })
    .showHelpAfterError()
    .exitOverride()
    .option("--port <port>", "TCP port; use 0 to select an available port.", "3000")
    .option("--host <host>", "Network interface to bind.", "127.0.0.1")
    .option("--root <directory>", "Static export directory.", "out")
    .option("--skip-e2e-marker-check", "Serve exports without the E2E bridge marker.")
}

export function parseArgs(argv) {
  const program = createProgram()
  try {
    program.parse(argv, { from: "user" })
  } catch (error) {
    if (error instanceof CommanderError && error.code === "commander.helpDisplayed") return null
    throw error
  }
  const options = program.opts()
  return cliSchema.parse({ ...options, skipMarkerCheck: options.skipE2eMarkerCheck })
}

async function main(argv) {
  const args = parseArgs(argv)
  if (!args) return
  const root = path.resolve(args.root)
  if (!existsSync(path.join(root, "index.html"))) {
    console.error(
      `[serve-out] ${root}/index.html not found — build the static export first:\n` +
        `  NEXT_PUBLIC_E2E=1 pnpm build`
    )
    process.exit(1)
  }
  if (!args.skipMarkerCheck && !exportHasE2eMarker(root)) {
    console.error(
      `[serve-out] the export at ${root} was built WITHOUT NEXT_PUBLIC_E2E=1 — ` +
        `the test-globals bridge ("${E2E_MARKER}") is absent and every spec ` +
        `would time out. Rebuild with:\n  NEXT_PUBLIC_E2E=1 pnpm build\n` +
        `(or pass --skip-e2e-marker-check to serve anyway)`
    )
    process.exit(1)
  }
  const server = createOutServer(root)
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject)
    server.listen(args.port, args.host, resolvePromise)
  })
  const { port } = server.address()
  console.log(`[serve-out] serving ${root} at http://${args.host}:${port}`)
  const shutdown = () => server.close(() => process.exit(0))
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`[serve-out] ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })
}
