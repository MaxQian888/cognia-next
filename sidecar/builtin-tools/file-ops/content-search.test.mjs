import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import fs from "node:fs"
import os from "node:os"

import { execContentSearch } from "./content-search.mjs"

let TMP
before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-fe-content-"))
})
after(() => {
  fs.rmSync(TMP, { recursive: true, force: true })
})

function decode(result) {
  return JSON.parse(result.content[0].text)
}

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

test("content_search skips .gitignored files by default", async () => {
  const dir = path.join(TMP, "cs-gitignore")
  fs.mkdirSync(path.join(dir, "build"), { recursive: true })
  fs.writeFileSync(path.join(dir, ".gitignore"), "build/\n*.gen.txt\n")
  fs.writeFileSync(path.join(dir, "keep.txt"), "needle here\n")
  fs.writeFileSync(path.join(dir, "out.gen.txt"), "needle here\n")
  fs.writeFileSync(path.join(dir, "build", "artifact.txt"), "needle here\n")
  const r = await execContentSearch({
    directory: dir,
    pattern: "needle",
    regex: false,
    caseSensitive: false,
    recursive: true,
    respectGitignore: true,
    maxResults: 10,
  })
  const data = decode(r)
  assert.deepEqual(
    data.matches.map((m) => m.file),
    ["keep.txt"]
  )
})

test("content_search respectGitignore=false searches ignored files too", async () => {
  const dir = path.join(TMP, "cs-noignore")
  fs.mkdirSync(path.join(dir, "build"), { recursive: true })
  fs.writeFileSync(path.join(dir, ".gitignore"), "build/\n")
  fs.writeFileSync(path.join(dir, "keep.txt"), "needle\n")
  fs.writeFileSync(path.join(dir, "build", "artifact.txt"), "needle\n")
  const r = await execContentSearch({
    directory: dir,
    pattern: "needle",
    regex: false,
    caseSensitive: false,
    recursive: true,
    respectGitignore: false,
    maxResults: 10,
  })
  const data = decode(r)
  assert.equal(data.matches.length, 2)
})

test("content_search caps results and surfaces an explicit, non-silent truncation note", async () => {
  const dir = path.join(TMP, "cs-truncate")
  fs.mkdirSync(dir, { recursive: true })
  // 5 matching lines, cap at 2 → must truncate.
  fs.writeFileSync(path.join(dir, "x.txt"), "hit\nhit\nhit\nhit\nhit\n")
  const r = await execContentSearch({
    directory: dir,
    pattern: "hit",
    regex: false,
    caseSensitive: false,
    recursive: true,
    maxResults: 2,
  })
  const data = decode(r)
  assert.equal(data.matches.length, 2)
  assert.equal(data.truncated, true)
  assert.match(data.note, /capped at 2 matches/)
  assert.match(data.note, /more exist/)
})

test("content_search omits the truncation note when results fit", async () => {
  const dir = path.join(TMP, "cs-fit")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "x.txt"), "hit\nmiss\nhit\n")
  const r = await execContentSearch({
    directory: dir,
    pattern: "hit",
    regex: false,
    caseSensitive: false,
    recursive: true,
    maxResults: 10,
  })
  const data = decode(r)
  assert.equal(data.matches.length, 2)
  assert.equal(data.truncated, false)
  assert.equal(data.note, undefined)
})

test("content_search preserves deterministic file+line order under concurrent reads", async () => {
  const dir = path.join(TMP, "cs-order")
  fs.mkdirSync(dir, { recursive: true })
  // More files than READ_CONCURRENCY (16) so batching is exercised; each file
  // has the needle so every batch produces matches. Zero-padded names keep
  // fast-glob's lexical order unambiguous.
  const names = []
  for (let i = 0; i < 40; i++) {
    const name = `f${String(i).padStart(3, "0")}.txt`
    names.push(name)
    fs.writeFileSync(path.join(dir, name), "noise\nneedle\n")
  }
  const r = await execContentSearch({
    directory: dir,
    pattern: "needle",
    regex: false,
    caseSensitive: false,
    recursive: true,
    maxResults: 100,
  })
  const data = decode(r)
  assert.equal(data.matches.length, 40)
  // File order is fast-glob lexical; line is always 2 (1-based, after "noise").
  assert.deepEqual(
    data.matches.map((m) => m.file),
    [...names].sort()
  )
  assert.ok(data.matches.every((m) => m.line === 2))
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
