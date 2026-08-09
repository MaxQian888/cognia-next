/**
 * Regression coverage for scripts/download-cubism-core.mjs.
 *
 * The download logic is exported and takes injectable fetch / dest / log, so we
 * exercise it directly against temp dirs and a fake fetch — no real network and
 * no real CDN. Covers: skip-when-present, graceful-fail (non-200 and thrown),
 * and the happy atomic-write path.
 *
 * Run with: node --test scripts/download-cubism-core.test.mjs
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  rmSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  downloadCubismCore,
  MIN_VALID_BYTES,
  DEFAULT_CUBISM_CORE_URL,
  DEFAULT_DEST,
} from "./download-cubism-core.mjs"

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), "cubism-core-"))
}

function fakeResponse({ ok = true, status = 200, body = "" }) {
  return {
    ok,
    status,
    arrayBuffer: async () => Buffer.from(body),
  }
}

test("exports sensible defaults", () => {
  assert.match(DEFAULT_CUBISM_CORE_URL, /live2dcubismcore\.min\.js$/)
  assert.match(DEFAULT_DEST, /live2dcubismcore\.min\.js$/)
  assert.equal(MIN_VALID_BYTES, 10 * 1024)
})

test("skips when a populated file is already present (no fetch)", async () => {
  const root = tmpRoot()
  const dest = join(root, "live2dcubismcore.min.js")
  writeFileSync(dest, Buffer.alloc(MIN_VALID_BYTES + 1))

  const messages = []
  let fetched = false
  const result = await downloadCubismCore({
    dest,
    fetchImpl: async () => {
      fetched = true
      return fakeResponse({ body: "x" })
    },
    log: (m) => messages.push(m),
  })

  assert.equal(result.status, "skipped")
  assert.equal(fetched, false)
  assert.match(messages[0], /already present/)
  rmSync(root, { recursive: true, force: true })
})

test("re-downloads when the existing file is below the size threshold", async () => {
  const root = tmpRoot()
  const dest = join(root, "live2dcubismcore.min.js")
  writeFileSync(dest, Buffer.alloc(100)) // stub / partial

  const big = "L".repeat(MIN_VALID_BYTES + 50)
  const result = await downloadCubismCore({
    dest,
    fetchImpl: async () => fakeResponse({ body: big }),
    log: () => {},
  })

  assert.equal(result.status, "downloaded")
  assert.equal(readFileSync(dest, "utf8"), big)
  rmSync(root, { recursive: true, force: true })
})

test("downloads and atomically writes the core file (creates parent dir)", async () => {
  const root = tmpRoot()
  const dest = join(root, "nested", "live2dcubismcore.min.js")
  const body = "CUBISM-CORE-BYTES"

  let calledUrl = null
  let calledHeaders = null
  const messages = []
  const result = await downloadCubismCore({
    dest,
    url: "https://example.test/core.js",
    fetchImpl: async (url, init) => {
      calledUrl = url
      calledHeaders = init?.headers
      return fakeResponse({ body })
    },
    log: (m) => messages.push(m),
  })

  assert.equal(result.status, "downloaded")
  assert.equal(existsSync(dest), true)
  assert.equal(readFileSync(dest, "utf8"), body)
  assert.equal(calledUrl, "https://example.test/core.js")
  assert.match(calledHeaders["User-Agent"], /Mozilla/)
  assert.match(messages[0], /done/)
  assert.deepEqual(readdirSync(join(root, "nested")), ["live2dcubismcore.min.js"])
  rmSync(root, { recursive: true, force: true })
})

test("graceful-fail on a non-200 response (exit-0 contract, no file written)", async () => {
  const root = tmpRoot()
  const dest = join(root, "live2dcubismcore.min.js")

  const messages = []
  const result = await downloadCubismCore({
    dest,
    fetchImpl: async () => fakeResponse({ ok: false, status: 403 }),
    log: (m) => messages.push(m),
  })

  assert.equal(result.status, "failed")
  assert.equal(result.reason, "HTTP 403")
  assert.equal(existsSync(dest), false)
  assert.match(messages[0], /download failed \(HTTP 403\).*fall back to SVG/)
  rmSync(root, { recursive: true, force: true })
})

test("graceful-fail when fetch returns nothing", async () => {
  const root = tmpRoot()
  const dest = join(root, "live2dcubismcore.min.js")
  const messages = []
  const result = await downloadCubismCore({
    dest,
    fetchImpl: async () => undefined,
    log: (m) => messages.push(m),
  })
  assert.equal(result.status, "failed")
  assert.equal(result.reason, "HTTP no-response")
  assert.equal(existsSync(dest), false)
  rmSync(root, { recursive: true, force: true })
})

test("graceful-fail when fetch throws (offline)", async () => {
  const root = tmpRoot()
  const dest = join(root, "live2dcubismcore.min.js")

  const messages = []
  const result = await downloadCubismCore({
    dest,
    fetchImpl: async () => {
      throw new Error("ENOTFOUND")
    },
    log: (m) => messages.push(m),
  })

  assert.equal(result.status, "failed")
  assert.match(result.reason, /ENOTFOUND/)
  assert.equal(existsSync(dest), false)
  assert.match(messages[0], /download failed \(ENOTFOUND\).*fall back to SVG/)
  rmSync(root, { recursive: true, force: true })
})

test("honors the CUBISM_CORE_URL env override when no url is passed", async () => {
  const root = tmpRoot()
  const dest = join(root, "live2dcubismcore.min.js")
  const prev = process.env.CUBISM_CORE_URL
  process.env.CUBISM_CORE_URL = "https://mirror.test/core.js"

  let calledUrl = null
  await downloadCubismCore({
    dest,
    fetchImpl: async (url) => {
      calledUrl = url
      return fakeResponse({ body: "Z".repeat(MIN_VALID_BYTES + 1) })
    },
    log: () => {},
  })

  assert.equal(calledUrl, "https://mirror.test/core.js")
  if (prev === undefined) delete process.env.CUBISM_CORE_URL
  else process.env.CUBISM_CORE_URL = prev
  rmSync(root, { recursive: true, force: true })
})
