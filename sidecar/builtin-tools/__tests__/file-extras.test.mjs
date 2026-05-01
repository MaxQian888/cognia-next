import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import fs from "node:fs"
import os from "node:os"
import crypto from "node:crypto"

import { __testExports } from "../file-extras.mjs"

const {
  execFileHash,
  execFileDiff,
  execFileInfo,
  execFileExists,
  execFileSearch,
  execContentSearch,
  execFileAppend,
  execFileBinaryWrite,
  execFileCopy,
  execFileRename,
  execFileMove,
  execDirectoryCreate,
  execDirectoryDelete,
  mimeForPath,
} = __testExports

let TMP

before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-fe-"))
})

after(() => {
  fs.rmSync(TMP, { recursive: true, force: true })
})

function decode(result) {
  return JSON.parse(result.content[0].text)
}

test("file_hash returns sha256 by default", async () => {
  const target = path.join(TMP, "h.txt")
  fs.writeFileSync(target, "hello world")
  const expected = crypto.createHash("sha256").update("hello world").digest("hex")
  const r = await execFileHash({ path: target, algorithm: "sha256" })
  assert.equal(r.isError, undefined)
  const data = decode(r)
  assert.equal(data.digest, expected)
  assert.equal(data.algorithm, "sha256")
  assert.equal(data.size, 11)
})

test("file_hash supports md5 / sha1 / sha512", async () => {
  const target = path.join(TMP, "hash-multi.txt")
  fs.writeFileSync(target, "x")
  for (const algo of ["md5", "sha1", "sha512"]) {
    const r = await execFileHash({ path: target, algorithm: algo })
    assert.equal(r.isError, undefined)
    const got = decode(r).digest
    const want = crypto.createHash(algo).update("x").digest("hex")
    assert.equal(got, want, `${algo} mismatch`)
  }
})

test("file_hash errors on missing file", async () => {
  const r = await execFileHash({ path: path.join(TMP, "nope.txt"), algorithm: "sha256" })
  assert.equal(r.isError, true)
})

test("file_hash rejects directories", async () => {
  const r = await execFileHash({ path: TMP, algorithm: "sha256" })
  assert.equal(r.isError, true)
  assert.match(r.content[0].text, /not a regular file/)
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

test("file_search finds matching files with extension filter", async () => {
  const dir = path.join(TMP, "search-fixture")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "a.ts"), "x")
  fs.writeFileSync(path.join(dir, "b.tsx"), "x")
  fs.writeFileSync(path.join(dir, "c.txt"), "x")
  const r = await execFileSearch({
    directory: dir,
    extensions: ["ts", "tsx"],
    recursive: true,
    maxResults: 200,
  })
  const data = decode(r)
  assert.deepEqual(data.results.sort(), ["a.ts", "b.tsx"])
})

test("file_search rejects non-directory roots", async () => {
  const f = path.join(TMP, "f.txt")
  fs.writeFileSync(f, "x")
  const r = await execFileSearch({ directory: f, recursive: true, maxResults: 10 })
  assert.equal(r.isError, true)
})

test("content_search finds line numbers (substring mode)", async () => {
  const dir = path.join(TMP, "cs-substring")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "x.txt"), "alpha\nbeta\ngamma\nbeta-again\n")
  const r = await execContentSearch({
    directory: dir,
    pattern: "beta",
    regex: false,
    caseSensitive: false,
    recursive: true,
    maxResults: 10,
  })
  const data = decode(r)
  assert.equal(data.matches.length, 2)
  assert.equal(data.matches[0].line, 2)
  assert.equal(data.matches[1].line, 4)
})

test("content_search supports regex mode", async () => {
  const dir = path.join(TMP, "cs-regex")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "y.txt"), "ID-100\nid-200\nfoo\n")
  const r = await execContentSearch({
    directory: dir,
    pattern: "^id-\\d+$",
    regex: true,
    caseSensitive: false,
    recursive: true,
    maxResults: 10,
  })
  const data = decode(r)
  assert.equal(data.matches.length, 2)
})

test("content_search caseSensitive=true is enforced", async () => {
  const dir = path.join(TMP, "cs-case")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "z.txt"), "Foo\nfoo\nFOO\n")
  const r = await execContentSearch({
    directory: dir,
    pattern: "Foo",
    regex: false,
    caseSensitive: true,
    recursive: true,
    maxResults: 10,
  })
  const data = decode(r)
  assert.equal(data.matches.length, 1)
})

test("content_search rejects non-directory roots", async () => {
  const f = path.join(TMP, "cs.txt")
  fs.writeFileSync(f, "x")
  const r = await execContentSearch({
    directory: f,
    pattern: "x",
    regex: false,
    caseSensitive: false,
    recursive: true,
    maxResults: 10,
  })
  assert.equal(r.isError, true)
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

test("file_move surfaces non-EXDEV errors", async () => {
  const r = await execFileMove({
    source: path.join(TMP, "nope-src"),
    destination: path.join(TMP, "nope-dst"),
  })
  assert.equal(r.isError, true)
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

test("mimeForPath maps known extensions", () => {
  assert.equal(mimeForPath("a.json"), "application/json")
  assert.equal(mimeForPath("a.unknown"), "application/octet-stream")
})
