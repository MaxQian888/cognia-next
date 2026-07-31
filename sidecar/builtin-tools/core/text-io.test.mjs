import { test } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import os from "node:os"
import fsp from "node:fs/promises"

import { decodeText, encodeText, readTextPreserving, withFileLock } from "./text-io.mjs"

const BOM = String.fromCharCode(0xfeff)

test("decodeText strips BOM and normalizes CRLF, reporting traits", () => {
  const d = decodeText(`${BOM}a\r\nb\r\nc`)
  assert.equal(d.content, "a\nb\nc")
  assert.equal(d.bom, true)
  assert.equal(d.eol, "\r\n")
})

test("decodeText keeps LF files as-is", () => {
  const d = decodeText("a\nb\n")
  assert.deepEqual([d.content, d.bom, d.eol], ["a\nb\n", false, "\n"])
})

test("decodeText picks the dominant EOL for mixed files", () => {
  assert.equal(decodeText("a\r\nb\r\nc\nd\r\n").eol, "\r\n")
  assert.equal(decodeText("a\nb\nc\r\n").eol, "\n")
})

test("encodeText restores BOM and CRLF", () => {
  assert.equal(encodeText("a\nb", { bom: true, eol: "\r\n" }), `${BOM}a\r\nb`)
  assert.equal(encodeText("a\nb", { bom: false, eol: "\n" }), "a\nb")
})

test("decode → encode round-trips byte-identically", () => {
  for (const raw of [`${BOM}x\r\ny\r\n`, "x\ny\n", "no trailing", `${BOM}only`]) {
    const d = decodeText(raw)
    assert.equal(encodeText(d.content, d), raw)
  }
})

test("readTextPreserving returns content traits and stat", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "tio-"))
  try {
    const f = path.join(dir, "crlf.txt")
    await fsp.writeFile(f, `${BOM}line1\r\nline2\r\n`)
    const r = await readTextPreserving(f)
    assert.equal(r.content, "line1\nline2\n")
    assert.equal(r.bom, true)
    assert.equal(r.eol, "\r\n")
    assert.ok(r.stat.mtimeMs > 0)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("withFileLock serializes work per key", async () => {
  const order = []
  const slow = withFileLock("k", async () => {
    await new Promise((r) => setTimeout(r, 30))
    order.push("slow")
  })
  const fast = withFileLock("k", async () => {
    order.push("fast")
  })
  await Promise.all([slow, fast])
  assert.deepEqual(order, ["slow", "fast"])
})

test("withFileLock does not let a failure poison the chain, and rejects through", async () => {
  await assert.rejects(
    withFileLock("k2", async () => {
      throw new Error("boom")
    }),
    /boom/
  )
  const v = await withFileLock("k2", async () => 42)
  assert.equal(v, 42)
})

test("withFileLock runs different keys concurrently", async () => {
  let aStarted = false
  const a = withFileLock("ka", async () => {
    aStarted = true
    await new Promise((r) => setTimeout(r, 30))
  })
  const b = withFileLock("kb", async () => {
    // b should start while a is still pending
    assert.equal(aStarted, true)
    return "b"
  })
  assert.equal(await b, "b")
  await a
})
