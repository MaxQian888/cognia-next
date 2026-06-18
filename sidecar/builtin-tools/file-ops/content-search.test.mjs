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
