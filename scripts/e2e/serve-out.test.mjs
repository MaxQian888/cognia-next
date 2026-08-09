/**
 * Regression coverage for scripts/e2e/serve-out.mjs — the static-export
 * server the Playwright suite uses under PLAYWRIGHT_STATIC=1.
 *
 * Run with: node --test scripts/e2e/serve-out.test.mjs
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  contentTypeFor,
  resolveFilePath,
  exportHasE2eMarker,
  createOutServer,
  E2E_MARKER,
  parseArgs,
} from "./serve-out.mjs"

test("parseArgs uses safe defaults and validates the port", () => {
  assert.deepEqual(parseArgs([]), {
    host: "127.0.0.1",
    port: 3000,
    root: "out",
    skipMarkerCheck: false,
  })
  assert.deepEqual(parseArgs(["--port", "0", "--root", "fixture", "--skip-e2e-marker-check"]), {
    host: "127.0.0.1",
    port: 0,
    root: "fixture",
    skipMarkerCheck: true,
  })
  assert.throws(() => parseArgs(["--port", "65536"]), /between 0 and 65535/)
  assert.throws(() => parseArgs(["--unknown"]), /unknown option/i)
})

/** Build a minimal fake `out/` export in a temp dir. */
function makeExport({ withMarker = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "serve-out-"))
  writeFileSync(join(root, "index.html"), "<html>home</html>")
  writeFileSync(join(root, "goals.html"), "<html>goals</html>")
  writeFileSync(join(root, "404.html"), "<html>missing</html>")
  mkdirSync(join(root, "goals"), { recursive: true })
  writeFileSync(join(root, "goals", "__next.goals.txt"), "rsc-payload")
  mkdirSync(join(root, "nested"), { recursive: true })
  writeFileSync(join(root, "nested", "index.html"), "<html>nested-index</html>")
  const chunks = join(root, "_next", "static", "chunks")
  mkdirSync(chunks, { recursive: true })
  writeFileSync(
    join(chunks, "main-abc123.js"),
    withMarker ? `window.${E2E_MARKER}=async()=>{}` : "console.log('prod')"
  )
  writeFileSync(join(chunks, "styles.css"), "body{}")
  return root
}

async function withServer(root, fn) {
  const server = createOutServer(root)
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    await fn(base)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test("resolveFilePath maps export-style routes", async () => {
  const root = makeExport()
  assert.equal(await resolveFilePath(root, "/"), join(root, "index.html"))
  assert.equal(await resolveFilePath(root, "/goals"), join(root, "goals.html"))
  // Directory with no index.html falls back to the sibling .html file.
  assert.equal(await resolveFilePath(root, "/goals/"), join(root, "goals.html"))
  assert.equal(await resolveFilePath(root, "/nested"), join(root, "nested", "index.html"))
  assert.equal(
    await resolveFilePath(root, "/goals/__next.goals.txt"),
    join(root, "goals", "__next.goals.txt")
  )
  assert.equal(await resolveFilePath(root, "/does-not-exist"), null)
  rmSync(root, { recursive: true, force: true })
})

test("resolveFilePath rejects traversal and malformed escapes", async () => {
  const root = makeExport()
  assert.equal(await resolveFilePath(root, "/../secret"), null)
  assert.equal(await resolveFilePath(root, "/%2e%2e/%2e%2e/etc/passwd"), null)
  assert.equal(await resolveFilePath(root, "/%zz"), null) // undecodable
  rmSync(root, { recursive: true, force: true })
})

test("contentTypeFor maps known and unknown extensions", () => {
  assert.equal(contentTypeFor("a.html"), "text/html; charset=utf-8")
  assert.equal(contentTypeFor("a.woff2"), "font/woff2")
  assert.equal(contentTypeFor("a.unknownext"), "application/octet-stream")
})

test("exportHasE2eMarker detects the bridge marker in chunks", () => {
  const withMarker = makeExport({ withMarker: true })
  const withoutMarker = makeExport({ withMarker: false })
  assert.equal(exportHasE2eMarker(withMarker), true)
  assert.equal(exportHasE2eMarker(withoutMarker), false)
  assert.equal(exportHasE2eMarker(join(withMarker, "nope")), false)
  rmSync(withMarker, { recursive: true, force: true })
  rmSync(withoutMarker, { recursive: true, force: true })
})

test("server serves routes, assets, 404 page, HEAD, and rejects other methods", async () => {
  const root = makeExport()
  await withServer(root, async (base) => {
    const home = await fetch(`${base}/`)
    assert.equal(home.status, 200)
    assert.match(await home.text(), /home/)

    const goals = await fetch(`${base}/goals?tab=active`)
    assert.equal(goals.status, 200)
    assert.equal(goals.headers.get("content-type"), "text/html; charset=utf-8")
    assert.match(await goals.text(), /goals/)

    const css = await fetch(`${base}/_next/static/chunks/styles.css`)
    assert.equal(css.status, 200)
    assert.equal(css.headers.get("content-type"), "text/css; charset=utf-8")

    const missing = await fetch(`${base}/definitely-not-a-route`)
    assert.equal(missing.status, 404)
    assert.match(await missing.text(), /missing/)

    const head = await fetch(`${base}/goals`, { method: "HEAD" })
    assert.equal(head.status, 200)
    assert.equal(await head.text(), "")

    const post = await fetch(`${base}/goals`, { method: "POST" })
    assert.equal(post.status, 405)
  })
  rmSync(root, { recursive: true, force: true })
})

test("server returns plain 404 when 404.html itself is absent", async () => {
  const root = makeExport()
  rmSync(join(root, "404.html"))
  await withServer(root, async (base) => {
    const missing = await fetch(`${base}/definitely-not-a-route`)
    assert.equal(missing.status, 404)
    assert.equal(await missing.text(), "Not Found")
  })
  rmSync(root, { recursive: true, force: true })
})
