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

test("file_diff rejects when either side is a directory", async () => {
  const a = path.join(TMP, "a.txt")
  fs.writeFileSync(a, "x")
  const r = await execFileDiff({ pathA: a, pathB: TMP, context: 3 })
  assert.equal(r.isError, true)
})
