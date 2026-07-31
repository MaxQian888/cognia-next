import { test } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import os from "node:os"
import fsp from "node:fs/promises"

import { createLsTool, nameGlobToRegExp } from "./ls.mjs"

function textOf(result) {
  return result.content.map((b) => b.text).join("\n")
}

test("ls lists dirs first with trailing slash, sorted", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ls-"))
  try {
    await fsp.mkdir(path.join(dir, "zdir"))
    await fsp.mkdir(path.join(dir, "adir"))
    await fsp.writeFile(path.join(dir, "bfile.txt"), "")
    const tool = createLsTool({ cwd: dir })
    const text = textOf(await tool.handler({}, {}))
    const lines = text.split("\n").slice(1)
    assert.deepEqual(lines, ["adir/", "zdir/", "bfile.txt"])
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("ls applies ignore globs", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ls-"))
  try {
    await fsp.writeFile(path.join(dir, "keep.ts"), "")
    await fsp.writeFile(path.join(dir, "drop.log"), "")
    const tool = createLsTool({ cwd: dir })
    const text = textOf(await tool.handler({ ignore: ["*.log"] }, {}))
    assert.ok(text.includes("keep.ts"))
    assert.ok(!text.includes("drop.log"))
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("ls errors usefully on a missing directory", async () => {
  const tool = createLsTool({ cwd: os.tmpdir() })
  const res = await tool.handler({ path: "definitely-missing-dir-xyz" }, {})
  assert.equal(res.isError, true)
})

test("nameGlobToRegExp matches whole names only", () => {
  assert.equal(nameGlobToRegExp("*.log").test("a.log"), true)
  assert.equal(nameGlobToRegExp("*.log").test("a.logx"), false)
  assert.equal(nameGlobToRegExp("data?").test("data1"), true)
  assert.equal(nameGlobToRegExp("node_modules").test("node_modules"), true)
})
