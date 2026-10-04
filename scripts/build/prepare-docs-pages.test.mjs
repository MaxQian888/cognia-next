import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomBytes } from "node:crypto"
import { gunzipSync } from "node:zlib"
import { prepareDocsPages } from "./prepare-docs-pages.mjs"

function fixture(t, data) {
  const dir = mkdtempSync(join(tmpdir(), "docs-pages-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, "api"))
  writeFileSync(join(dir, "api/search"), data)
  return dir
}

test("leaves small search exports fully static", (t) => {
  const dir = fixture(t, "{}")
  prepareDocsPages(dir)
  assert.equal(readFileSync(join(dir, "api/search"), "utf8"), "{}")
  assert.equal(existsSync(join(dir, "_worker.js")), false)
})

test("packages oversized indexes without losing either locale or any data", (t) => {
  const index = Buffer.from(JSON.stringify({ en: "documentation".repeat(2200000), zh: "文档" }))
  const dir = fixture(t, index)
  prepareDocsPages(dir)
  const compressed = readFileSync(join(dir, "api/search-index.json.gz"))
  assert.ok(compressed.byteLength <= 25 * 1024 * 1024)
  assert.deepEqual(gunzipSync(compressed), index)
  assert.equal(existsSync(join(dir, "api/search")), false)
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "_routes.json"), "utf8")), {
    version: 1,
    include: ["/api/search", "/api/search/"],
    exclude: [],
  })
  assert.deepEqual(
    readFileSync(join(dir, "_worker.js")),
    readFileSync(new URL("./docs-search-worker.mjs", import.meta.url))
  )
  prepareDocsPages(dir)
  assert.deepEqual(readFileSync(join(dir, "api/search-index.json.gz")), compressed)
})

test("rejects indexes that still exceed the asset limit without removing the original", (t) => {
  const index = randomBytes(25 * 1024 * 1024 + 1)
  const dir = fixture(t, index)
  assert.throws(() => prepareDocsPages(dir), /25 MiB limit/)
  assert.deepEqual(readFileSync(join(dir, "api/search")), index)
  assert.equal(existsSync(join(dir, "_worker.js")), false)
})
