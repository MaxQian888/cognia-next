#!/usr/bin/env node
/**
 * Download the Live2D Cubism Core runtime (`live2dcubismcore.min.js`) into
 * `public/live2d/` so the Tauri/web Live2D pet skin can register the runtime
 * offline. The file is proprietary (redistributable code, but NOT vendored into
 * git — see `.gitignore`), so it is fetched at build time instead of committed.
 *
 * Run before `pnpm dev` / `pnpm build` (wired into `predev` / `prebuild`).
 * Idempotent — skips when a populated file already exists. NEVER fails the
 * build: any network/CDN error logs a warning and exits 0 so offline builds
 * still succeed (the Live2D skin then falls back to the SVG skin at runtime).
 *
 * The CDN 403s bare clients, so requests carry a desktop browser User-Agent.
 * Set `CUBISM_CORE_URL` to use a mirror.
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import writeFileAtomic from "write-file-atomic"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, "../..")

/** Official Cubism Core CDN. Overridable for mirrors via `CUBISM_CORE_URL`. */
export const DEFAULT_CUBISM_CORE_URL =
  "https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js"

/** Destination inside the Next.js `public/` dir (served at `/live2d/...`). */
export const DEFAULT_DEST = path.resolve(ROOT, "public", "live2d", "live2dcubismcore.min.js")

/**
 * Below this size the existing file is treated as a stub/partial download and
 * re-fetched. The real core file is ~200KB.
 */
export const MIN_VALID_BYTES = 10 * 1024

/** Desktop browser UA — the CDN 403s bare/Node clients. */
const DESKTOP_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

/**
 * Core logic, injectable for tests.
 *
 * @param {object} [opts]
 * @param {string} [opts.dest] - Output path for the core file.
 * @param {string} [opts.url]  - Source URL.
 * @param {typeof globalThis.fetch} [opts.fetchImpl] - Fetch implementation.
 * @param {(msg: string) => void} [opts.log] - Logger.
 * @returns {Promise<{ status: "skipped" | "downloaded" | "failed", reason?: string }>}
 */
export async function downloadCubismCore(opts = {}) {
  const dest = opts.dest ?? DEFAULT_DEST
  const url = opts.url ?? process.env.CUBISM_CORE_URL ?? DEFAULT_CUBISM_CORE_URL
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const log = opts.log ?? console.log

  // Skip when a populated file is already present.
  if (fs.existsSync(dest)) {
    let size = 0
    try {
      size = fs.statSync(dest).size
    } catch {
      size = 0
    }
    if (size > MIN_VALID_BYTES) {
      log("[live2d] skip: already present")
      return { status: "skipped" }
    }
  }

  try {
    const res = await fetchImpl(url, { headers: { "User-Agent": DESKTOP_USER_AGENT } })
    if (!res || !res.ok) {
      const reason = `HTTP ${res ? res.status : "no-response"}`
      log(`[live2d] skip: download failed (${reason}) — Live2D skin will fall back to SVG`)
      return { status: "failed", reason }
    }
    const buf = Buffer.from(await res.arrayBuffer())
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    writeFileAtomic.sync(dest, buf)
    log(`[live2d] done: ${dest} (${buf.length} bytes)`)
    return { status: "downloaded" }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    log(`[live2d] skip: download failed (${reason}) — Live2D skin will fall back to SVG`)
    return { status: "failed", reason }
  }
}

// Run when invoked directly (not when imported by the test).
if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("download-cubism-core.mjs")
) {
  downloadCubismCore()
    .catch((err) => {
      // Defensive: the function already swallows errors, but never let an
      // unexpected throw fail the build.
      console.log(
        `[live2d] skip: download failed (${err instanceof Error ? err.message : String(err)}) — Live2D skin will fall back to SVG`
      )
    })
    .finally(() => process.exit(0))
}
