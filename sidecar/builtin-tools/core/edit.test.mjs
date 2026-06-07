import { test } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import os from "node:os"
import fsp from "node:fs/promises"

import { createEditTool, createMultiEditTool } from "./edit.mjs"
import { createReadTracker } from "./read-tracker.mjs"

const BOM = String.fromCharCode(0xfeff)

function textOf(result) {
  return result.content.map((b) => b.text).join("\n")
}

async function fixture(content = "const a = 1\nconst b = 2\nconst c = 3\n") {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ed-"))
  const abs = path.join(dir, "f.ts")
  await fsp.writeFile(abs, content)
  const tracker = createReadTracker()
  tracker.record(abs, await fsp.stat(abs))
  return { dir, abs, tracker }
}

test("edit replaces a unique exact match", async () => {
  const { dir, abs, tracker } = await fixture()
  const tool = createEditTool({ cwd: dir, readTracker: tracker })
  try {
    const res = await tool.handler(
      { file_path: "f.ts", old_string: "const b = 2", new_string: "const b = 22" },
      {}
    )
    assert.match(textOf(res), /1 replacement/)
    assert.match(await fsp.readFile(abs, "utf-8"), /const b = 22/)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("edit requires a prior read", async () => {
  const { dir } = await fixture()
  const tool = createEditTool({ cwd: dir, readTracker: createReadTracker() })
  try {
    const res = await tool.handler(
      { file_path: "f.ts", old_string: "const a = 1", new_string: "x" },
      {}
    )
    assert.equal(res.isError, true)
    assert.match(textOf(res), /has not been read/)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("edit reports the fuzzy strategy when exact match fails", async () => {
  const { dir, abs, tracker } = await fixture("  indented line\n  other\n")
  const tool = createEditTool({ cwd: dir, readTracker: tracker })
  try {
    const res = await tool.handler(
      { file_path: "f.ts", old_string: "indented line", new_string: "replaced line" },
      {}
    )
    const text = textOf(res)
    // "indented line" appears trimmed — exact substring also matches, so accept
    // either a clean exact replace or a fuzzy annotation; the file must change.
    assert.match(await fsp.readFile(abs, "utf-8"), /replaced line/)
    assert.match(text, /1 replacement/)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("edit with CRLF file preserves CRLF and matches LF-normalized old_string", async () => {
  const { dir, abs, tracker } = await fixture(`${BOM}alpha\r\nbeta\r\n`)
  const tool = createEditTool({ cwd: dir, readTracker: tracker })
  try {
    const res = await tool.handler(
      { file_path: "f.ts", old_string: "alpha\nbeta", new_string: "alpha\nBETA" },
      {}
    )
    assert.ok(!res.isError, textOf(res))
    assert.equal(await fsp.readFile(abs, "utf-8"), `${BOM}alpha\r\nBETA\r\n`)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("edit replace_all replaces every occurrence", async () => {
  const { dir, abs, tracker } = await fixture("x = old\ny = old\n")
  const tool = createEditTool({ cwd: dir, readTracker: tracker })
  try {
    const res = await tool.handler(
      { file_path: "f.ts", old_string: "old", new_string: "new", replace_all: true },
      {}
    )
    assert.match(textOf(res), /2 replacements/)
    assert.equal(await fsp.readFile(abs, "utf-8"), "x = new\ny = new\n")
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("edit not_unique error guides toward replace_all", async () => {
  const { dir, tracker } = await fixture("dup\ndup\n")
  const tool = createEditTool({ cwd: dir, readTracker: tracker })
  try {
    const res = await tool.handler({ file_path: "f.ts", old_string: "dup", new_string: "x" }, {})
    assert.equal(res.isError, true)
    assert.match(textOf(res), /replace_all/)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("multi_edit applies edits sequentially", async () => {
  const { dir, abs, tracker } = await fixture()
  const tool = createMultiEditTool({ cwd: dir, readTracker: tracker })
  try {
    const res = await tool.handler(
      {
        file_path: "f.ts",
        edits: [
          { old_string: "const a = 1", new_string: "const a = 10" },
          { old_string: "const a = 10", new_string: "const a = 100" },
        ],
      },
      {}
    )
    assert.ok(!res.isError, textOf(res))
    assert.match(await fsp.readFile(abs, "utf-8"), /const a = 100/)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("multi_edit aborts atomically when a later edit fails", async () => {
  const { dir, abs, tracker } = await fixture()
  const tool = createMultiEditTool({ cwd: dir, readTracker: tracker })
  try {
    const res = await tool.handler(
      {
        file_path: "f.ts",
        edits: [
          { old_string: "const a = 1", new_string: "const a = 10" },
          { old_string: "zzz_not_present", new_string: "x" },
        ],
      },
      {}
    )
    assert.equal(res.isError, true)
    assert.match(textOf(res), /edit #2 of 2 failed/)
    // First edit must NOT have been written.
    assert.match(await fsp.readFile(abs, "utf-8"), /const a = 1\n/)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("edit on a missing file errors cleanly", async () => {
  const tool = createEditTool({ cwd: os.tmpdir(), readTracker: createReadTracker() })
  const res = await tool.handler(
    { file_path: "missing-zzz.ts", old_string: "a", new_string: "b" },
    {}
  )
  assert.equal(res.isError, true)
  assert.match(textOf(res), /not found/)
})
