#!/usr/bin/env node
/**
 * Download the real per-theme share wallpapers and (re)generate the committed
 * module `lib/export/html/wallpapers.generated.ts`, which maps each immersive
 * share theme to a small, inlined `data:image/*;base64,` URL.
 *
 * Unlike the Live2D core (git-ignored, downloaded on every build), the generated
 * module is COMMITTED — it is the offline source of truth so a fresh checkout,
 * the Capacitor mobile bundle (no service worker), and the public Cloudflare
 * Pages viewer all render wallpapers with zero network. This script is a
 * maintenance tool: run `pnpm share:wallpapers` to refresh the images.
 *
 * Contract (mirrors scripts/build/download-cubism-core.mjs):
 *  - Idempotent: skips when the module already has a valid data URL for every
 *    manifest theme (unless `force`).
 *  - Atomic: writes a temp file then renames.
 *  - NEVER fails the build: any error logs a warning and exits 0; a theme that
 *    fails validation is dropped (others are kept), and the previously committed
 *    module survives a total failure.
 *  - Requests already-optimized small images from the source CDN (imgix/Pexels
 *    params) so no local image library is needed; validates magic bytes + a size
 *    cap and inlines whatever format came back (webp/jpeg/png).
 *
 * Provenance & license: every image is openly licensed (Unsplash License / Pexels
 * License / CC0) and mood-matched to the theme — never copyrighted franchise art.
 * The credit line for each is recorded in the generated module's header comment.
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, "../..")

/** Committed generated module (runtime source of truth). */
export const DEFAULT_DEST = path.resolve(
  ROOT,
  "lib",
  "export",
  "html",
  "wallpapers.generated.ts"
)

/** Per-image size ceiling. Base64 inflates ~4/3, so ≤120 KB → ≤160 KB ASCII. */
export const MAX_WALLPAPER_BYTES = 120 * 1024

/** Desktop UA — image CDNs 403 bare/Node clients. */
const DESKTOP_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

/**
 * Theme → wallpaper source. Mixed Unsplash / Pexels, whichever best matches the
 * theme's mood; all openly licensed. Unsplash uses imgix params
 * (`w`/`q`/`fm=webp`/`fit=crop`) → a pre-optimized small WebP; Pexels uses its
 * `auto=compress&w=` params. `credit` is recorded in the generated header.
 */
export const WALLPAPER_MANIFEST = {
  arknights: {
    url: "https://images.unsplash.com/photo-1518770660439-4636190af475?w=1100&q=38&fm=webp&fit=crop&crop=entropy",
    credit: "Arknights (tactical circuitry) — photo by Umberto (unsplash.com/@umby), Unsplash License",
  },
  cyberpunk: {
    url: "https://images.unsplash.com/photo-1519608487953-e999c86e7455?w=1280&q=45&fm=webp&fit=crop&crop=entropy",
    credit: "Cyberpunk (neon night city) — photo by Andre Benz (unsplash.com/@trapnation), Unsplash License",
  },
  terminal: {
    url: "https://images.unsplash.com/photo-1544197150-b99a580bb7a8?w=1280&q=45&fm=webp&fit=crop&crop=entropy",
    credit: "Terminal (dark server racks) — photo by Taylor Vick (unsplash.com/@tvick), Unsplash License",
  },
  sakura: {
    url: "https://images.unsplash.com/photo-1522383225653-ed111181a951?w=1280&q=50&fm=webp&fit=crop&crop=entropy",
    credit: "Sakura (cherry blossom) — photo by Sora Sagano (unsplash.com/@sorasagano), Unsplash License",
  },
  "catppuccin-mocha": {
    url: "https://images.unsplash.com/photo-1465101162946-4377e57745c3?w=960&q=28&fm=webp&fit=crop&crop=entropy",
    credit: "Catppuccin Mocha (lavender dusk) — photo by Kristopher Roller (unsplash.com/@krisroller), Unsplash License",
  },
  aurora: {
    url: "https://images.unsplash.com/photo-1483347756197-71ef80e95f73?w=1100&q=40&fm=webp&fit=crop&crop=entropy",
    credit: "Aurora (northern lights) — photo by Vincent Guth (unsplash.com/@vingtcent), Unsplash License",
  },
  genshin: {
    url: "https://images.unsplash.com/photo-1470071459604-3b5ec3a7fe05?w=1200&q=40&fm=webp&fit=crop&crop=entropy",
    credit: "Genshin (fantasy green vista) — photo by Robert Lukeman (unsplash.com/@robertlukeman), Unsplash License",
  },
  honkai: {
    url: "https://images.unsplash.com/photo-1462331940025-496dfbfc7564?w=1280&q=45&fm=webp&fit=crop&crop=entropy",
    credit: "Honkai: Star Rail (starfield nebula) — photo by Jeremy Thomas (unsplash.com/@jeremythomasphoto), Unsplash License",
  },
}

/** Detect an inlineable image type from magic bytes. */
export function detectImageMime(buf) {
  if (!buf || buf.length < 12) return null
  // WebP: "RIFF"....."WEBP"
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return "image/webp"
  }
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg"
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return "image/png"
  }
  return null
}

/** True when the module already holds a data URL for every manifest theme. */
function moduleIsComplete(dest, manifest) {
  if (!fs.existsSync(dest)) return false
  let src = ""
  try {
    src = fs.readFileSync(dest, "utf8")
  } catch {
    return false
  }
  return Object.keys(manifest).every((theme) =>
    src.includes(`"${theme}": "data:image/`)
  )
}

/** Serialize the TS module from a theme→dataUrl map (+ credits header). Only
 * the themes actually inlined are credited. */
export function renderModule(entries, manifest) {
  const provenance = entries
    .map(([theme]) => `//   ${theme} → ${manifest[theme]?.credit ?? "(unknown source)"}`)
    .join("\n")
  const body = entries
    .map(([theme, dataUrl]) => `  "${theme}": "${dataUrl}",`)
    .join("\n")
  return `// AUTO-GENERATED by scripts/build/download-share-wallpapers.mjs — do not edit by hand.
// Regenerate: pnpm share:wallpapers
//
// Real, openly-licensed wallpaper photos inlined as data URLs so the exported
// share HTML renders them offline inside a sandboxed iframe (about:srcdoc) and on
// the public Cloudflare Pages viewer, with zero network. Each image is
// mood-matched to its theme — never copyrighted franchise art.
//
// Provenance:
${provenance}

import type { ThemeId } from "./syntax-themes"

export const THEME_WALLPAPERS: Partial<Record<ThemeId, string>> = {
${body}
}
`
}

/**
 * Core logic, injectable for tests.
 *
 * @param {object} [opts]
 * @param {string} [opts.dest]
 * @param {Record<string, { url: string, credit: string }>} [opts.manifest]
 * @param {typeof globalThis.fetch} [opts.fetchImpl]
 * @param {(msg: string) => void} [opts.log]
 * @param {boolean} [opts.force]
 * @returns {Promise<{ status: "skipped" | "generated" | "failed", reason?: string, themes?: string[] }>}
 */
export async function downloadShareWallpapers(opts = {}) {
  const dest = opts.dest ?? DEFAULT_DEST
  const manifest = opts.manifest ?? WALLPAPER_MANIFEST
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const log = opts.log ?? console.log
  const force = opts.force ?? false

  if (!force && moduleIsComplete(dest, manifest)) {
    log("[wallpapers] skip: module already complete")
    return { status: "skipped" }
  }

  try {
    /** @type {[string, string][]} */
    const entries = []
    for (const [theme, entry] of Object.entries(manifest)) {
      try {
        const res = await fetchImpl(entry.url, {
          headers: { "User-Agent": DESKTOP_USER_AGENT },
        })
        if (!res || !res.ok) {
          log(`[wallpapers] drop ${theme}: HTTP ${res ? res.status : "no-response"}`)
          continue
        }
        const buf = Buffer.from(await res.arrayBuffer())
        const mime = detectImageMime(buf)
        if (!mime) {
          log(`[wallpapers] drop ${theme}: unrecognized image bytes`)
          continue
        }
        if (buf.length > MAX_WALLPAPER_BYTES) {
          log(`[wallpapers] drop ${theme}: ${buf.length} bytes over cap`)
          continue
        }
        entries.push([theme, `data:${mime};base64,${buf.toString("base64")}`])
        log(`[wallpapers] ok ${theme}: ${buf.length} bytes (${mime})`)
      } catch (err) {
        log(`[wallpapers] drop ${theme}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    if (entries.length === 0) {
      log("[wallpapers] skip: no images fetched — keeping existing module")
      return { status: "failed", reason: "no-images" }
    }

    const moduleSource = renderModule(entries, manifest)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    const tmp = `${dest}.tmp-${process.pid}`
    fs.writeFileSync(tmp, moduleSource)
    fs.renameSync(tmp, dest)
    log(`[wallpapers] done: ${dest} (${entries.length}/${Object.keys(manifest).length} themes)`)
    return { status: "generated", themes: entries.map(([t]) => t) }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    log(`[wallpapers] skip: generation failed (${reason}) — keeping existing module`)
    return { status: "failed", reason }
  }
}

// Run when invoked directly (not when imported by the test). The argv[1] clause
// is what makes it fire under Windows where the `file://` comparison fails.
if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("download-share-wallpapers.mjs")
) {
  downloadShareWallpapers({ force: process.argv.includes("--force") })
    .catch((err) => {
      console.log(
        `[wallpapers] skip: generation failed (${err instanceof Error ? err.message : String(err)})`
      )
    })
    .finally(() => process.exit(0))
}
