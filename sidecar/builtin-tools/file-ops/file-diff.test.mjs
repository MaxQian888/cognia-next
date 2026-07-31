import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import fs from "node:fs"
import os from "node:os"

import { execFileDiff } from "./file-diff.mjs"

let TMP
before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-fe-diff-"))
})
after(() => {
  fs.rmSync(TMP, { recursive: true, force: true })
})

test("file_diff produces a unified diff", async () => {
  const a = path.join(TMP, "a.txt")
  const b = path.join(TMP, "b.txt")
  fs.writeFileSync(a, "line1\nline2\nline3\n")
  fs.writeFileSync(b, "line1\nLINE2\nline3\n")
  const r = await execFileDiff({ pathA: a, pathB: b, context: 3 })
  assert.equal(r.isError, undefined)
  const text = r.content[0].text
  assert.match(text, /^---/m)
  assert.match(text, /^\+\+\+/m)
  assert.match(text, /-line2/)
  assert.match(text, /\+LINE2/)
})

test("file_diff caps an oversized patch and appends guidance", async () => {
  const a = path.join(TMP, "big-a.txt")
  const b = path.join(TMP, "big-b.txt")
  // Long, all-different lines: a ~640 KB patch (well over the 256 KB cap) from
  // only 2000 lines, so createPatch's LCS stays fast.
  const pad = "x".repeat(150)
  fs.writeFileSync(a, Array.from({ length: 2000 }, (_, i) => `old-${i}-${pad}`).join("\n") + "\n")
  fs.writeFileSync(b, Array.from({ length: 2000 }, (_, i) => `new-${i}-${pad}`).join("\n") + "\n")
  const r = await execFileDiff({ pathA: a, pathB: b, context: 3 })
  assert.equal(r.isError, undefined)
  const text = r.content[0].text
  assert.match(text, /truncated/)
  assert.ok(text.length < 300 * 1024, "patch text should be capped near 256 KB")
})

test("file_diff rejects when either side is a directory", async () => {
  const a = path.join(TMP, "a.txt")
  fs.writeFileSync(a, "x")
  const r = await execFileDiff({ pathA: a, pathB: TMP, context: 3 })
  assert.equal(r.isError, true)
})
