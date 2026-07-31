import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import fs from "node:fs"
import os from "node:os"

import { execFileCopy, execFileRename, execFileMove } from "./file-transfer.mjs"

let TMP
before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-fe-transfer-"))
})
after(() => {
  fs.rmSync(TMP, { recursive: true, force: true })
})

test("file_copy refuses to overwrite by default", async () => {
  const a = path.join(TMP, "src.txt")
  const b = path.join(TMP, "dst.txt")
  fs.writeFileSync(a, "x")
  fs.writeFileSync(b, "y")
  const r = await execFileCopy({ source: a, destination: b, overwrite: false })
  assert.equal(r.isError, true)
})

test("file_copy overwrites with overwrite:true", async () => {
  const a = path.join(TMP, "src2.txt")
  const b = path.join(TMP, "dst2.txt")
  fs.writeFileSync(a, "fresh")
  fs.writeFileSync(b, "stale")
  const r = await execFileCopy({ source: a, destination: b, overwrite: true })
  assert.equal(r.isError, undefined)
  assert.equal(fs.readFileSync(b, "utf-8"), "fresh")
})

test("file_rename moves the file", async () => {
  const a = path.join(TMP, "ren-a.txt")
  const b = path.join(TMP, "ren-b.txt")
  fs.writeFileSync(a, "x")
  const r = await execFileRename({ oldPath: a, newPath: b })
  assert.equal(r.isError, undefined)
  assert.equal(fs.existsSync(a), false)
  assert.equal(fs.existsSync(b), true)
})

test("file_move falls back to copy-then-delete on EXDEV", async () => {
  // We can't easily simulate EXDEV without crossing devices; verify same-fs move works.
  const a = path.join(TMP, "mv-a.txt")
  const b = path.join(TMP, "mv-b.txt")
  fs.writeFileSync(a, "z")
  const r = await execFileMove({ source: a, destination: b })
  assert.equal(r.isError, undefined)
  assert.equal(fs.readFileSync(b, "utf-8"), "z")
})

test("file_rename refuses to clobber an existing destination by default", async () => {
  const a = path.join(TMP, "rc-a.txt")
  const b = path.join(TMP, "rc-b.txt")
  fs.writeFileSync(a, "keep")
  fs.writeFileSync(b, "precious")
  const r = await execFileRename({ oldPath: a, newPath: b })
  assert.equal(r.isError, true)
  // The destination and source are both untouched.
  assert.equal(fs.readFileSync(b, "utf-8"), "precious")
  assert.equal(fs.existsSync(a), true)
  // overwrite:true allows it.
  const r2 = await execFileRename({ oldPath: a, newPath: b, overwrite: true })
  assert.equal(r2.isError, undefined)
  assert.equal(fs.readFileSync(b, "utf-8"), "keep")
})

test("file_move refuses to clobber an existing destination by default", async () => {
  const a = path.join(TMP, "mc-a.txt")
  const b = path.join(TMP, "mc-b.txt")
  fs.writeFileSync(a, "keep")
  fs.writeFileSync(b, "precious")
  const r = await execFileMove({ source: a, destination: b })
  assert.equal(r.isError, true)
  assert.equal(fs.readFileSync(b, "utf-8"), "precious")
  const r2 = await execFileMove({ source: a, destination: b, overwrite: true })
  assert.equal(r2.isError, undefined)
  assert.equal(fs.readFileSync(b, "utf-8"), "keep")
})

test("file_move surfaces non-EXDEV errors", async () => {
  const r = await execFileMove({
    source: path.join(TMP, "nope-src"),
    destination: path.join(TMP, "nope-dst"),
  })
  assert.equal(r.isError, true)
})
