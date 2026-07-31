/**
 * Coverage for scripts/ci/report/bundle.mjs.
 *
 * The walk takes injected I/O, so the tree shapes below exercise recursion
 * and classification without writing a fake static export to disk. One test
 * measures a real temp directory to pin that the injected and real paths
 * agree.
 *
 * Run with: node --test scripts/ci/report/bundle.test.mjs
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { diffBundle, formatBytes, measureBundle, summarizeFiles, walk } from "./bundle.mjs"

/** Build injectable I/O from a `{ "a/b.js": 10 }` map. */
function fakeIo(tree) {
  const dirent = (name, isDir) => ({ name, isDirectory: () => isDir })
  return {
    readdir(dir) {
      const prefix = dir === "root" ? "" : `${dir.slice("root/".length)}/`
      const seen = new Map()
      for (const path of Object.keys(tree)) {
        if (!path.startsWith(prefix)) continue
        const rest = path.slice(prefix.length)
        const [head, ...tail] = rest.split("/")
        if (!seen.has(head)) seen.set(head, dirent(head, tail.length > 0))
      }
      return [...seen.values()]
    },
    stat(full) {
      return { size: tree[full.slice("root/".length)] ?? 0 }
    },
  }
}

const TREE = {
  "index.html": 1000,
  "_next/static/chunks/main.js": 5000,
  "_next/static/chunks/vendor.js": 9000,
  "_next/static/css/app.css": 300,
  "_next/static/media/font.woff2": 700,
}

test("walk recurses and returns repo-relative posix paths, sorted", () => {
  const files = walk("root", fakeIo(TREE))
  assert.deepEqual(
    files.map((f) => f.path),
    [
      "_next/static/chunks/main.js",
      "_next/static/chunks/vendor.js",
      "_next/static/css/app.css",
      "_next/static/media/font.woff2",
      "index.html",
    ]
  )
})

test("summarizeFiles classifies by extension and totals everything", () => {
  const summary = summarizeFiles(walk("root", fakeIo(TREE)))
  assert.equal(summary.totalBytes, 16000)
  assert.equal(summary.fileCount, 5)
  assert.equal(summary.jsBytes, 14000)
  assert.equal(summary.cssBytes, 300)
  assert.equal(summary.htmlBytes, 1000)
})

test("summarizeFiles ranks the largest JS chunks first", () => {
  const summary = summarizeFiles(walk("root", fakeIo(TREE)))
  assert.deepEqual(
    summary.largestChunks.map((c) => c.path),
    ["_next/static/chunks/vendor.js", "_next/static/chunks/main.js"]
  )
  // Non-JS assets never appear in the chunk ranking.
  assert.ok(!summary.largestChunks.some((c) => c.path.endsWith(".css")))
})

test("summarizeFiles handles an empty export without dividing by zero", () => {
  const summary = summarizeFiles([])
  assert.equal(summary.totalBytes, 0)
  assert.equal(summary.fileCount, 0)
  assert.deepEqual(summary.largestChunks, [])
})

test("diffBundle reports deltas and percentages against a base", () => {
  const base = summarizeFiles([{ path: "a.js", bytes: 1000 }])
  const current = summarizeFiles([{ path: "a.js", bytes: 1500 }])
  const diff = diffBundle(current, base)

  assert.equal(diff.hasBase, true)
  const js = diff.metrics.find((m) => m.key === "jsBytes")
  assert.equal(js.from, 1000)
  assert.equal(js.to, 1500)
  assert.equal(js.delta, 500)
  assert.equal(js.percent, 50)
})

test("diffBundle says so when there is no baseline, instead of inventing one", () => {
  const diff = diffBundle(summarizeFiles([{ path: "a.js", bytes: 10 }]), null)
  assert.equal(diff.hasBase, false)
  assert.deepEqual(diff.metrics, [])
})

test("diffBundle leaves percent null when the baseline metric is zero", () => {
  const base = summarizeFiles([{ path: "a.js", bytes: 10 }])
  const current = summarizeFiles([
    { path: "a.js", bytes: 10 },
    { path: "b.css", bytes: 5 },
  ])
  const css = diffBundle(current, base).metrics.find((m) => m.key === "cssBytes")
  assert.equal(css.from, 0)
  assert.equal(css.delta, 5)
  assert.equal(css.percent, null)
})

test("formatBytes scales units and keeps the sign", () => {
  assert.equal(formatBytes(0), "0 B")
  assert.equal(formatBytes(512), "512 B")
  assert.equal(formatBytes(2048), "2.0 KB")
  assert.equal(formatBytes(-1536), "-1.5 KB")
  assert.equal(formatBytes(5 * 1024 * 1024), "5.0 MB")
})

test("measureBundle reads a real directory the same way as the injected walk", () => {
  const root = mkdtempSync(join(tmpdir(), "bundle-"))
  mkdirSync(join(root, "static"), { recursive: true })
  writeFileSync(join(root, "index.html"), "x".repeat(100))
  writeFileSync(join(root, "static", "app.js"), "y".repeat(250))

  const summary = measureBundle(root)
  assert.equal(summary.fileCount, 2)
  assert.equal(summary.totalBytes, 350)
  assert.equal(summary.jsBytes, 250)
  assert.equal(summary.htmlBytes, 100)
  assert.deepEqual(
    summary.largestChunks.map((c) => c.path),
    ["static/app.js"]
  )
})
