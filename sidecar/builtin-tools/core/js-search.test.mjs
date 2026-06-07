import { test } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import os from "node:os"
import fsp from "node:fs/promises"

import { jsGlob, jsGrep, looksBinary } from "./js-search.mjs"

async function makeFixture() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "jss-"))
  await fsp.mkdir(path.join(dir, "src"), { recursive: true })
  await fsp.mkdir(path.join(dir, "dist"), { recursive: true })
  await fsp.writeFile(path.join(dir, ".gitignore"), "dist/\n")
  await fsp.writeFile(path.join(dir, "src", "a.ts"), "const needle = 1\nplain line\nneedle again\n")
  await fsp.writeFile(path.join(dir, "src", "b.ts"), "no match here\n")
  await fsp.writeFile(path.join(dir, "top.md"), "needle in markdown\n")
  await fsp.writeFile(path.join(dir, "dist", "ignored.ts"), "needle should be ignored\n")
  await fsp.writeFile(path.join(dir, "bin.dat"), Buffer.from([0x4e, 0x00, 0x65, 0x65]))
  return dir
}

test("jsGlob matches patterns, respects .gitignore, sorts deterministically", async () => {
  const dir = await makeFixture()
  try {
    const { files, truncated } = await jsGlob({ pattern: "**/*.ts", cwd: dir })
    assert.deepEqual(files, ["src/a.ts", "src/b.ts"])
    assert.equal(truncated, false)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("jsGlob caps results and reports truncation", async () => {
  const dir = await makeFixture()
  try {
    const { files, truncated } = await jsGlob({ pattern: "**/*", cwd: dir, cap: 1 })
    assert.equal(files.length, 1)
    assert.equal(truncated, true)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("jsGrep finds line matches sorted by (file, line), skipping gitignored + binary", async () => {
  const dir = await makeFixture()
  try {
    const { matches, fileCount } = await jsGrep({ pattern: "needle", root: dir })
    assert.deepEqual(
      matches.map((m) => `${m.file}:${m.line}`),
      ["src/a.ts:1", "src/a.ts:3", "top.md:1"]
    )
    assert.equal(fileCount, 2)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("jsGrep honours glob filter and ignoreCase", async () => {
  const dir = await makeFixture()
  try {
    const { matches } = await jsGrep({
      pattern: "NEEDLE",
      root: dir,
      glob: "**/*.ts",
      ignoreCase: true,
    })
    assert.deepEqual(
      matches.map((m) => m.file),
      ["src/a.ts", "src/a.ts"]
    )
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("jsGrep multiline matches across lines and reports the start line", async () => {
  const dir = await makeFixture()
  try {
    await fsp.writeFile(path.join(dir, "multi.txt"), "alpha\nstart\nend\nomega\n")
    const { matches } = await jsGrep({
      pattern: "start.end",
      root: dir,
      multiline: true,
      glob: "multi.txt",
    })
    assert.equal(matches.length, 1)
    assert.equal(matches[0].line, 2)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("jsGrep caps matches and reports truncation", async () => {
  const dir = await makeFixture()
  try {
    const { matches, truncated } = await jsGrep({ pattern: "needle", root: dir, cap: 1 })
    assert.equal(matches.length, 1)
    assert.equal(truncated, true)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("jsGrep throws on an invalid regex", async () => {
  await assert.rejects(
    jsGrep({ pattern: "([", root: os.tmpdir() }),
    /Invalid regular expression|Unterminated/
  )
})

test("looksBinary detects NUL bytes", () => {
  assert.equal(looksBinary(Buffer.from([0x61, 0x00])), true)
  assert.equal(looksBinary(Buffer.from("plain text")), false)
})
