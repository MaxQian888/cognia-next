import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import fs from "node:fs"
import os from "node:os"

import { statOrNull, ensureExists } from "./fs-stat.mjs"

let TMP

before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-fsstat-"))
})

after(() => {
  fs.rmSync(TMP, { recursive: true, force: true })
})

test("statOrNull returns Stats for an existing file", async () => {
  const f = path.join(TMP, "a.txt")
  fs.writeFileSync(f, "abc")
  const st = await statOrNull(f)
  assert.ok(st)
  assert.equal(st.isFile(), true)
  assert.equal(st.size, 3)
})

test("statOrNull returns null for a missing path", async () => {
  assert.equal(await statOrNull(path.join(TMP, "nope")), null)
})

test("ensureExists returns Stats for an existing path", async () => {
  const st = await ensureExists(TMP)
  assert.equal(st.isDirectory(), true)
})

test("ensureExists throws 'file not found' for a missing path", async () => {
  await assert.rejects(() => ensureExists(path.join(TMP, "ghost")), /file not found/)
})
