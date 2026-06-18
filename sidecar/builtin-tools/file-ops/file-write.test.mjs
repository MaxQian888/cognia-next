import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import fs from "node:fs"
import os from "node:os"

import { execFileAppend, execFileBinaryWrite } from "./file-write.mjs"

let TMP
before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-fe-write-"))
})
after(() => {
  fs.rmSync(TMP, { recursive: true, force: true })
})

test("file_append creates and appends", async () => {
  const f = path.join(TMP, "append.txt")
  await execFileAppend({ path: f, content: "first\n", ensureTrailingNewline: false })
  await execFileAppend({ path: f, content: "second", ensureTrailingNewline: true })
  const body = fs.readFileSync(f, "utf-8")
  assert.equal(body, "first\nsecond\n")
})

test("file_binary_write writes base64 payload", async () => {
  const f = path.join(TMP, "bin.dat")
  const data = Buffer.from([1, 2, 3, 4, 5])
  await execFileBinaryWrite({
    path: f,
    data: data.toString("base64"),
    createDirectories: false,
  })
  const got = fs.readFileSync(f)
  assert.deepEqual([...got], [...data])
})

test("file_binary_write creates parent dirs when asked", async () => {
  const f = path.join(TMP, "nested", "deep", "bin.dat")
  await execFileBinaryWrite({
    path: f,
    data: Buffer.from([9]).toString("base64"),
    createDirectories: true,
  })
  assert.equal(fs.existsSync(f), true)
})
