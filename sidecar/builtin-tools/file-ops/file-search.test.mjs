import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import fs from "node:fs"
import os from "node:os"

import { execFileSearch } from "./file-search.mjs"

let TMP
before(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-fe-search-"))
})
after(() => {
  fs.rmSync(TMP, { recursive: true, force: true })
})

function decode(result) {
  return JSON.parse(result.content[0].text)
}

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

test("file_search skips .gitignored files by default", async () => {
  const dir = path.join(TMP, "search-gitignore")
  fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true })
  fs.writeFileSync(path.join(dir, ".gitignore"), "node_modules/\n*.gen.ts\n")
  fs.writeFileSync(path.join(dir, "keep.ts"), "x")
  fs.writeFileSync(path.join(dir, "skip.gen.ts"), "x")
  fs.writeFileSync(path.join(dir, "node_modules", "dep.ts"), "x")
  const r = await execFileSearch({
    directory: dir,
    extensions: ["ts"],
    recursive: true,
    respectGitignore: true,
    maxResults: 200,
  })
  const data = decode(r)
  assert.deepEqual(data.results.sort(), ["keep.ts"])
})

test("file_search respectGitignore=false lists ignored files too", async () => {
  const dir = path.join(TMP, "search-noignore")
  fs.mkdirSync(path.join(dir, "dist"), { recursive: true })
  fs.writeFileSync(path.join(dir, ".gitignore"), "dist/\n")
  fs.writeFileSync(path.join(dir, "keep.ts"), "x")
  fs.writeFileSync(path.join(dir, "dist", "bundle.ts"), "x")
  const r = await execFileSearch({
    directory: dir,
    extensions: ["ts"],
    recursive: true,
    respectGitignore: false,
    maxResults: 200,
  })
  const data = decode(r)
  assert.deepEqual(data.results.sort(), ["dist/bundle.ts", "keep.ts"])
})

test("file_search rejects non-directory roots", async () => {
  const f = path.join(TMP, "f.txt")
  fs.writeFileSync(f, "x")
  const r = await execFileSearch({ directory: f, recursive: true, maxResults: 10 })
  assert.equal(r.isError, true)
})
