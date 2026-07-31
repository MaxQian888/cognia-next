import { test } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import os from "node:os"
import fsp from "node:fs/promises"

import { createGlobTool, enumerateGlob } from "./glob.mjs"

function textOf(result) {
  return result.content.map((b) => b.text).join("\n")
}

async function fixture() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "glob-"))
  await fsp.mkdir(path.join(dir, "src"), { recursive: true })
  await fsp.writeFile(path.join(dir, "src", "old.ts"), "old")
  // Ensure a measurable mtime gap.
  await new Promise((r) => setTimeout(r, 20))
  await fsp.writeFile(path.join(dir, "src", "new.ts"), "new")
  await fsp.writeFile(path.join(dir, "readme.md"), "")
  return dir
}

test("glob matches the pattern and sorts newest-first", async () => {
  const dir = await fixture()
  try {
    const tool = createGlobTool({ cwd: dir })
    const text = textOf(await tool.handler({ pattern: "**/*.ts" }, {}))
    const lines = text.split("\n")
    assert.equal(lines.length, 2)
    assert.match(lines[0], /new\.ts/)
    assert.match(lines[1], /old\.ts/)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("glob reports no matches cleanly", async () => {
  const dir = await fixture()
  try {
    const tool = createGlobTool({ cwd: dir })
    const text = textOf(await tool.handler({ pattern: "**/*.rs" }, {}))
    assert.match(text, /No files matched/)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("glob accepts an explicit path", async () => {
  const dir = await fixture()
  try {
    const tool = createGlobTool({ cwd: os.tmpdir() })
    const text = textOf(await tool.handler({ pattern: "*.ts", path: path.join(dir, "src") }, {}))
    assert.match(text, /new\.ts/)
    assert.match(text, /old\.ts/)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("enumerateGlob returns relative paths and a truncation flag", async () => {
  const dir = await fixture()
  try {
    const { files, truncated } = await enumerateGlob({ pattern: "**/*.ts", root: dir })
    assert.deepEqual([...files].sort(), ["src/new.ts", "src/old.ts"])
    assert.equal(truncated, false)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})
