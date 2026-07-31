import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import fs from "node:fs"
import os from "node:os"

import { execDirectoryCreate, execDirectoryDelete } from "./directory-ops.mjs"

let TMP
before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-fe-dir-"))
})
after(() => {
  fs.rmSync(TMP, { recursive: true, force: true })
})

test("directory_create with recursive=true makes nested dirs", async () => {
  const d = path.join(TMP, "newdir", "a", "b")
  const r = await execDirectoryCreate({ path: d, recursive: true })
  assert.equal(r.isError, undefined)
  assert.equal(fs.statSync(d).isDirectory(), true)
})

test("directory_create with recursive=false fails on missing parents", async () => {
  const d = path.join(TMP, "lone", "child")
  const r = await execDirectoryCreate({ path: d, recursive: false })
  assert.equal(r.isError, true)
})

test("directory_delete refuses non-existent paths", async () => {
  const r = await execDirectoryDelete({
    path: path.join(TMP, "absent"),
    recursive: false,
  })
  assert.equal(r.isError, true)
})

test("directory_delete refuses regular files", async () => {
  const f = path.join(TMP, "notdir.txt")
  fs.writeFileSync(f, "x")
  const r = await execDirectoryDelete({ path: f, recursive: false })
  assert.equal(r.isError, true)
})

test("directory_delete needs recursive for non-empty dirs", async () => {
  const dir = path.join(TMP, "del-nonempty")
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, "a.txt"), "x")
  const r = await execDirectoryDelete({ path: dir, recursive: false })
  assert.equal(r.isError, true)
})

test("directory_delete with recursive=true removes the tree", async () => {
  const dir = path.join(TMP, "del-rec")
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, "a.txt"), "x")
  const r = await execDirectoryDelete({ path: dir, recursive: true })
  assert.equal(r.isError, undefined)
  assert.equal(fs.existsSync(dir), false)
})
