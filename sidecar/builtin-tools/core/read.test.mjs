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

// 1x1 transparent PNG.
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
)

test("read renders .ipynb notebooks as text and tracks them", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "read-nb-"))
  const nb = path.join(dir, "n.ipynb")
  const tracker = createReadTracker()
  await fsp.writeFile(
    nb,
    JSON.stringify({ cells: [{ cell_type: "code", source: ["print(1)\n"], outputs: [] }] })
  )
  const tool = createReadTool({ cwd: dir, readTracker: tracker })
  try {
    const res = await tool.handler({ file_path: "n.ipynb" }, {})
    assert.match(textOf(res), /Cell 1 \[code\]/)
    assert.match(textOf(res), /print\(1\)/)
    assert.equal(tracker.hasRead(nb), true)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("read returns an image content block for a vision-capable model", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "read-img-"))
  const img = path.join(dir, "p.png")
  const tracker = createReadTracker()
  await fsp.writeFile(img, PNG_1X1)
  const tool = createReadTool({
    cwd: dir,
    readTracker: tracker,
    provider: "anthropic",
    model: "claude-opus-4-5",
  })
  try {
    const res = await tool.handler({ file_path: "p.png" }, {})
    const imageBlock = res.content.find((b) => b.type === "image")
    assert.ok(imageBlock, "expected an image content block")
    assert.equal(imageBlock.mimeType, "image/png")
    assert.equal(imageBlock.data, PNG_1X1.toString("base64"))
    assert.equal(tracker.hasRead(img), true)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("read gives an honest redirect for an image when the model has no vision", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "read-img2-"))
  const img = path.join(dir, "p.png")
  await fsp.writeFile(img, PNG_1X1)
  const tool = createReadTool({ cwd: dir, readTracker: createReadTracker() }) // no model
  try {
    const res = await tool.handler({ file_path: "p.png" }, {})
    assert.match(textOf(res), /cannot accept image input|vision-capable/)
    assert.ok(!res.content.some((b) => b.type === "image"))
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("read directs PDFs to the attachment pipeline", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "read-pdf-"))
  const pdf = path.join(dir, "d.pdf")
  await fsp.writeFile(pdf, Buffer.from("%PDF-1.4\n%binary\x00", "latin1"))
  const tool = createReadTool({ cwd: dir, readTracker: createReadTracker() })
  try {
    const res = await tool.handler({ file_path: "d.pdf" }, {})
    assert.match(textOf(res), /PDF/)
    assert.match(textOf(res), /attach it with @/)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})
