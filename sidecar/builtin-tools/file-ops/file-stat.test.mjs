import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import fs from "node:fs"
import os from "node:os"

import { execFileInfo, execFileExists } from "./file-stat.mjs"

let TMP
before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-fe-stat-"))
})
after(() => {
  fs.rmSync(TMP, { recursive: true, force: true })
})

function decode(result) {
  return JSON.parse(result.content[0].text)
}

test("file_info returns size + mtime + isFile", async () => {
  const f = path.join(TMP, "i.txt")
  fs.writeFileSync(f, "abc")
  const r = await execFileInfo({ path: f })
  const data = decode(r)
  assert.equal(data.exists, true)
  assert.equal(data.isFile, true)
  assert.equal(data.size, 3)
  assert.equal(data.mime, "text/plain")
})

test("file_info returns exists:false for missing paths", async () => {
  const r = await execFileInfo({ path: path.join(TMP, "nope.bin") })
  const data = decode(r)
  assert.equal(data.exists, false)
})

test("file_exists returns true and false", async () => {
  const f = path.join(TMP, "e.txt")
  fs.writeFileSync(f, "x")
  const yes = decode(await execFileExists({ path: f }))
  assert.equal(yes.exists, true)
  const no = decode(await execFileExists({ path: path.join(TMP, "missing") }))
  assert.equal(no.exists, false)
})
