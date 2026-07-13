/**
 * Regression coverage for scripts/build/download-share-wallpapers.mjs.
 *
 * The generator is exported with injectable fetch / dest / manifest / log, so we
 * exercise it against temp dirs and a fake fetch — no real network. Covers:
 * defaults, skip-when-complete, force, happy multi-theme generation, per-theme
 * graceful degrade (non-200 / bad bytes / oversize), and total-failure exit-0.
 *
 * Run with: node --test scripts/build/download-share-wallpapers.test.mjs
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  downloadShareWallpapers,
  detectImageMime,
  renderModule,
  MAX_WALLPAPER_BYTES,
  DEFAULT_DEST,
} from "./download-share-wallpapers.mjs"

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), "share-wallpapers-"))
}

/** Minimal valid WebP: "RIFF" + size + "WEBP" + payload. */
function webp(size = 64) {
  const head = Buffer.from([
    0x52, 0x49, 0x46, 0x46, // RIFF
    0x00, 0x00, 0x00, 0x00, // (size, ignored)
    0x57, 0x45, 0x42, 0x50, // WEBP
  ])
  return Buffer.concat([head, Buffer.alloc(Math.max(0, size - head.length), 0x61)])
}

function fakeResponse({ ok = true, status = 200, buf = webp() }) {
  return { ok, status, arrayBuffer: async () => buf }
}

const MANIFEST = {
  arknights: { url: "https://img.test/a.webp", credit: "A — CC0" },
  cyberpunk: { url: "https://img.test/c.webp", credit: "C — CC0" },
}

test("exports sensible defaults", () => {
  assert.match(DEFAULT_DEST, /wallpapers\.generated\.ts$/)
  assert.equal(MAX_WALLPAPER_BYTES, 120 * 1024)
})

test("detectImageMime recognizes webp/jpeg/png and rejects junk", () => {
  assert.equal(detectImageMime(webp()), "image/webp")
  assert.equal(detectImageMime(Buffer.from([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0])), "image/jpeg")
  assert.equal(
    detectImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])),
    "image/png"
  )
  assert.equal(detectImageMime(Buffer.from("not an image at all")), null)
  assert.equal(detectImageMime(Buffer.alloc(4)), null)
})

test("renderModule emits a typed map with provenance", () => {
  const src = renderModule([["arknights", "data:image/webp;base64,QQ"]], MANIFEST)
  assert.match(src, /export const THEME_WALLPAPERS: Partial<Record<ThemeId, string>>/)
  assert.match(src, /"arknights": "data:image\/webp;base64,QQ",/)
  assert.match(src, /A — CC0/)
})

test("generates a module with a data URL per theme (atomic, creates dir)", async () => {
  const root = tmpRoot()
  const dest = join(root, "nested", "wallpapers.generated.ts")
  const calls = []
  const result = await downloadShareWallpapers({
    dest,
    manifest: MANIFEST,
    fetchImpl: async (url, init) => {
      calls.push({ url, ua: init?.headers?.["User-Agent"] })
      return fakeResponse({ buf: webp(80) })
    },
    log: () => {},
  })

  assert.equal(result.status, "generated")
  assert.deepEqual(result.themes, ["arknights", "cyberpunk"])
  const src = readFileSync(dest, "utf8")
  assert.match(src, /"arknights": "data:image\/webp;base64,/)
  assert.match(src, /"cyberpunk": "data:image\/webp;base64,/)
  assert.match(calls[0].ua, /Mozilla/)
  assert.equal(existsSync(`${dest}.tmp-${process.pid}`), false)
  rmSync(root, { recursive: true, force: true })
})

test("skips when the module already covers every theme (no fetch)", async () => {
  const root = tmpRoot()
  const dest = join(root, "wallpapers.generated.ts")
  writeFileSync(
    dest,
    'export const THEME_WALLPAPERS = {\n  "arknights": "data:image/webp;base64,AA",\n  "cyberpunk": "data:image/webp;base64,BB",\n}'
  )
  let fetched = false
  const result = await downloadShareWallpapers({
    dest,
    manifest: MANIFEST,
    fetchImpl: async () => {
      fetched = true
      return fakeResponse({})
    },
    log: () => {},
  })
  assert.equal(result.status, "skipped")
  assert.equal(fetched, false)
  rmSync(root, { recursive: true, force: true })
})

test("force re-fetches even when the module is complete", async () => {
  const root = tmpRoot()
  const dest = join(root, "wallpapers.generated.ts")
  writeFileSync(
    dest,
    'export const THEME_WALLPAPERS = {\n  "arknights": "data:image/webp;base64,AA",\n  "cyberpunk": "data:image/webp;base64,BB",\n}'
  )
  let fetched = 0
  const result = await downloadShareWallpapers({
    dest,
    manifest: MANIFEST,
    force: true,
    fetchImpl: async () => {
      fetched++
      return fakeResponse({ buf: webp(64) })
    },
    log: () => {},
  })
  assert.equal(result.status, "generated")
  assert.equal(fetched, 2)
  rmSync(root, { recursive: true, force: true })
})

test("drops a theme on non-200 / bad bytes / oversize but keeps the rest", async () => {
  const root = tmpRoot()
  const dest = join(root, "wallpapers.generated.ts")
  const manifest = {
    ok: { url: "https://img.test/ok.webp", credit: "ok" },
    http403: { url: "https://img.test/403.webp", credit: "x" },
    junk: { url: "https://img.test/junk.webp", credit: "x" },
    huge: { url: "https://img.test/huge.webp", credit: "x" },
  }
  const result = await downloadShareWallpapers({
    dest,
    manifest,
    fetchImpl: async (url) => {
      if (url.includes("403")) return fakeResponse({ ok: false, status: 403 })
      if (url.includes("junk")) return fakeResponse({ buf: Buffer.from("nope-not-an-image") })
      if (url.includes("huge")) return fakeResponse({ buf: webp(MAX_WALLPAPER_BYTES + 10) })
      return fakeResponse({ buf: webp(64) })
    },
    log: () => {},
  })
  assert.equal(result.status, "generated")
  assert.deepEqual(result.themes, ["ok"])
  const src = readFileSync(dest, "utf8")
  assert.match(src, /"ok": "data:image\/webp/)
  assert.doesNotMatch(src, /http403|junk|huge/)
  rmSync(root, { recursive: true, force: true })
})

test("total failure keeps the existing module (exit-0 contract)", async () => {
  const root = tmpRoot()
  const dest = join(root, "wallpapers.generated.ts")
  writeFileSync(dest, "// existing committed module\n")
  const result = await downloadShareWallpapers({
    dest,
    manifest: MANIFEST,
    force: true,
    fetchImpl: async () => {
      throw new Error("ENOTFOUND")
    },
    log: () => {},
  })
  assert.equal(result.status, "failed")
  assert.equal(result.reason, "no-images")
  assert.equal(readFileSync(dest, "utf8"), "// existing committed module\n")
  rmSync(root, { recursive: true, force: true })
})
