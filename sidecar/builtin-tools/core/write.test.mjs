import { test } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import os from "node:os"
import fsp from "node:fs/promises"

import { createWriteTool, diagnosticsAfterWrite, LSP_DIAG_TIMEOUT_MS } from "./write.mjs"
import { createReadTracker } from "./read-tracker.mjs"

const BOM = String.fromCharCode(0xfeff)

function textOf(result) {
  return result.content.map((b) => b.text).join("\n")
}

test("write creates a new file (parent dirs included) and records the read state", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "wr-"))
  const tracker = createReadTracker()
  const tool = createWriteTool({ cwd: dir, readTracker: tracker })
  try {
    const res = await tool.handler(
      { file_path: "deep/nested/new.txt", content: "hello\nworld\n" },
      {}
    )
    assert.match(textOf(res), /Created/)
    const abs = path.join(dir, "deep", "nested", "new.txt")
    assert.equal(await fsp.readFile(abs, "utf-8"), "hello\nworld\n")
    assert.equal(tracker.hasRead(abs), true)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("overwriting an existing file requires a prior read", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "wr-"))
  const tool = createWriteTool({ cwd: dir, readTracker: createReadTracker() })
  try {
    const abs = path.join(dir, "exists.txt")
    await fsp.writeFile(abs, "original")
    const res = await tool.handler({ file_path: "exists.txt", content: "clobber" }, {})
    assert.equal(res.isError, true)
    assert.match(textOf(res), /has not been read/)
    assert.equal(await fsp.readFile(abs, "utf-8"), "original")
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("overwrite preserves BOM and CRLF of the existing file", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "wr-"))
  const tracker = createReadTracker()
  const tool = createWriteTool({ cwd: dir, readTracker: tracker })
  try {
    const abs = path.join(dir, "crlf.txt")
    await fsp.writeFile(abs, `${BOM}a\r\nb\r\n`)
    tracker.record(abs, await fsp.stat(abs))
    const res = await tool.handler({ file_path: "crlf.txt", content: "x\ny\n" }, {})
    assert.match(textOf(res), /Updated/)
    assert.equal(await fsp.readFile(abs, "utf-8"), `${BOM}x\r\ny\r\n`)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("overwrite is rejected when the file changed since the read", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "wr-"))
  const tracker = createReadTracker()
  const tool = createWriteTool({ cwd: dir, readTracker: tracker })
  try {
    const abs = path.join(dir, "stale.txt")
    await fsp.writeFile(abs, "v1")
    const st = await fsp.stat(abs)
    tracker.record(abs, { mtimeMs: st.mtimeMs - 1000, size: st.size })
    const res = await tool.handler({ file_path: "stale.txt", content: "v2" }, {})
    assert.equal(res.isError, true)
    assert.match(textOf(res), /changed on disk/)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("write appends LSP diagnostics when the resolver reports problems", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "wr-"))
  const lspResolver = {
    getDiagnostics: async () => [
      { severity: 1, message: "type error: oops", range: { start: { line: 0, character: 0 } } },
    ],
  }
  const tool = createWriteTool({ cwd: dir, readTracker: createReadTracker(), lspResolver })
  try {
    const res = await tool.handler({ file_path: "diag.ts", content: "bad code\n" }, {})
    const text = textOf(res)
    assert.match(text, /Diagnostics after write/)
    assert.match(text, /type error: oops/)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("diagnosticsAfterWrite is best-effort: slow or broken resolvers yield empty", async () => {
  const slow = {
    getDiagnostics: () =>
      new Promise((r) =>
        setTimeout(() => r([{ severity: 1, message: "late" }]), LSP_DIAG_TIMEOUT_MS + 500)
      ),
  }
  const broken = {
    getDiagnostics: async () => {
      throw new Error("lsp down")
    },
  }
  assert.equal(await diagnosticsAfterWrite(slow, "/tmp/x.ts"), "")
  assert.equal(await diagnosticsAfterWrite(broken, "/tmp/x.ts"), "")
  assert.equal(await diagnosticsAfterWrite(null, "/tmp/x.ts"), "")
})
