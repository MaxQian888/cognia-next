import { test } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import os from "node:os"
import fsp from "node:fs/promises"

import { createReadTool, formatCatN, resolveToolPath, DEFAULT_LIMIT } from "./read.mjs"
import { createReadTracker } from "./read-tracker.mjs"

function textOf(result) {
  return result.content.map((b) => b.text).join("\n")
}

async function fixture() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "read-"))
  const file = path.join(dir, "f.txt")
  await fsp.writeFile(file, "alpha\nbeta\ngamma\ndelta\n")
  return { dir, file }
}

test("read returns cat -n numbered content and records into the tracker", async () => {
  const { dir, file } = await fixture()
  const tracker = createReadTracker()
  const tool = createReadTool({ cwd: dir, readTracker: tracker })
  try {
    const res = await tool.handler({ file_path: "f.txt" }, {})
    const text = textOf(res)
    assert.match(text, /^ {5}1\talpha/m)
    assert.match(text, /^ {5}4\tdelta/m)
    assert.equal(tracker.hasRead(file), true)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("read windows with offset/limit and emits a continuation hint", async () => {
  const { dir } = await fixture()
  const tool = createReadTool({ cwd: dir, readTracker: createReadTracker() })
  try {
    const res = await tool.handler({ file_path: "f.txt", offset: 2, limit: 2 }, {})
    const text = textOf(res)
    assert.match(text, /^ {5}2\tbeta/m)
    assert.match(text, /^ {5}3\tgamma/m)
    assert.ok(!text.includes("alpha"))
    assert.match(text, /continue with offset=4/)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("read errors when offset is beyond EOF and when the file is missing", async () => {
  const { dir } = await fixture()
  const tool = createReadTool({ cwd: dir, readTracker: createReadTracker() })
  try {
    const beyond = await tool.handler({ file_path: "f.txt", offset: 99 }, {})
    assert.equal(beyond.isError, true)
    const missing = await tool.handler({ file_path: "missing.txt" }, {})
    assert.equal(missing.isError, true)
    assert.match(textOf(missing), /not found/)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("read lists directories", async () => {
  const { dir } = await fixture()
  await fsp.mkdir(path.join(dir, "sub"))
  const tool = createReadTool({ cwd: dir, readTracker: createReadTracker() })
  try {
    const res = await tool.handler({ file_path: "." }, {})
    const text = textOf(res)
    assert.match(text, /is a directory/)
    assert.match(text, /sub\//)
    assert.match(text, /f\.txt/)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("read reports binary files without dumping bytes, and does not track them", async () => {
  const { dir } = await fixture()
  const tracker = createReadTracker()
  const bin = path.join(dir, "x.bin")
  await fsp.writeFile(bin, Buffer.from([0x00, 0x01, 0x02]))
  const tool = createReadTool({ cwd: dir, readTracker: tracker })
  try {
    const res = await tool.handler({ file_path: "x.bin" }, {})
    assert.match(textOf(res), /binary file/)
    assert.equal(tracker.hasRead(bin), false)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("formatCatN truncates very long lines", () => {
  const out = formatCatN(["x".repeat(5000)], 1)
  assert.ok(out.length < 5000)
  assert.match(out, /line truncated/)
})

test("resolveToolPath resolves relative against cwd and passes absolutes through", () => {
  const abs = path.resolve("/tmp/abs.txt")
  assert.equal(resolveToolPath("/base", abs), path.normalize(abs))
  assert.equal(resolveToolPath(os.tmpdir(), "rel.txt"), path.join(os.tmpdir(), "rel.txt"))
})

test("read tool metadata: name + default limit sanity", async () => {
  const tool = createReadTool({ cwd: ".", readTracker: createReadTracker() })
  assert.equal(tool.name, "read")
  assert.equal(DEFAULT_LIMIT, 2000)
})
