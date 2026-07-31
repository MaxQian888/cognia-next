import { test } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"

import { createReadTracker, canonicalKey } from "./read-tracker.mjs"

const FILE = path.resolve("/tmp/tracker/sample.txt")

test("record + hasRead round-trip", () => {
  const t = createReadTracker()
  assert.equal(t.hasRead(FILE), false)
  t.record(FILE, { mtimeMs: 100, size: 10 })
  assert.equal(t.hasRead(FILE), true)
})

test("assertReadBefore throws for a file never read", () => {
  const t = createReadTracker()
  assert.throws(() => t.assertReadBefore(FILE, { mtimeMs: 100, size: 10 }), /has not been read/)
})

test("assertReadBefore throws when mtime changed since the read", () => {
  const t = createReadTracker()
  t.record(FILE, { mtimeMs: 100, size: 10 })
  assert.throws(() => t.assertReadBefore(FILE, { mtimeMs: 200, size: 10 }), /changed on disk since/)
})

test("assertReadBefore passes when mtime is unchanged (size may differ)", () => {
  const t = createReadTracker()
  t.record(FILE, { mtimeMs: 100, size: 10 })
  assert.doesNotThrow(() => t.assertReadBefore(FILE, { mtimeMs: 100, size: 99 }))
})

test("relative and absolute spellings of the same path share a record", () => {
  const t = createReadTracker()
  const rel = path.relative(process.cwd(), path.resolve("sub/file.txt"))
  t.record(rel, { mtimeMs: 1, size: 1 })
  assert.equal(t.hasRead(path.resolve("sub/file.txt")), true)
})

test("clear() empties the tracker", () => {
  const t = createReadTracker()
  t.record(FILE, { mtimeMs: 1, size: 1 })
  t.clear()
  assert.equal(t.hasRead(FILE), false)
})

test("canonicalKey lower-cases the win32 drive letter only", () => {
  if (process.platform === "win32") {
    const k1 = canonicalKey("C:\\Some\\File.TXT")
    const k2 = canonicalKey("c:\\Some\\File.TXT")
    assert.equal(k1, k2)
    assert.ok(k1.includes("File.TXT"), "path body case is preserved")
  } else {
    assert.equal(canonicalKey("/a/b"), path.resolve("/a/b"))
  }
})
