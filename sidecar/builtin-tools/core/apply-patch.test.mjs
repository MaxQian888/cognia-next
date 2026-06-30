import { test } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import os from "node:os"
import fsp from "node:fs/promises"
import { createPatch } from "diff"

import { createApplyPatchTool } from "./apply-patch.mjs"
import { createReadTracker } from "./read-tracker.mjs"

const BOM = String.fromCharCode(0xfeff)

function textOf(result) {
  return result.content.map((b) => b.text).join("\n")
}

async function tmp() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "ap-"))
}

test("applies a single-file modification (round-trip) after a prior read", async () => {
  const dir = await tmp()
  const tracker = createReadTracker()
  const tool = createApplyPatchTool({ cwd: dir, readTracker: tracker })
  try {
    const abs = path.join(dir, "foo.txt")
    await fsp.writeFile(abs, "a\nb\nc\n")
    tracker.record(abs, await fsp.stat(abs))
    const patch = createPatch("foo.txt", "a\nb\nc\n", "a\nB\nc\n")
    const res = await tool.handler({ patch }, {})
    assert.match(textOf(res), /Applied patch to 1 file/)
    assert.equal(await fsp.readFile(abs, "utf-8"), "a\nB\nc\n")
    // The post-write stat is recorded so a follow-up edit doesn't trip the gate.
    assert.equal(tracker.hasRead(abs), true)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("modifying an existing file requires a prior read (nothing written)", async () => {
  const dir = await tmp()
  const tool = createApplyPatchTool({ cwd: dir, readTracker: createReadTracker() })
  try {
    const abs = path.join(dir, "foo.txt")
    await fsp.writeFile(abs, "a\nb\nc\n")
    const patch = createPatch("foo.txt", "a\nb\nc\n", "a\nB\nc\n")
    const res = await tool.handler({ patch }, {})
    assert.equal(res.isError, true)
    assert.match(textOf(res), /has not been read/)
    assert.match(textOf(res), /No changes were written/)
    assert.equal(await fsp.readFile(abs, "utf-8"), "a\nb\nc\n")
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("creates a new file from a /dev/null source hunk", async () => {
  const dir = await tmp()
  const tracker = createReadTracker()
  const tool = createApplyPatchTool({ cwd: dir, readTracker: tracker })
  try {
    const patch = ["--- /dev/null", "+++ new.txt", "@@ -0,0 +1,2 @@", "+hello", "+world", ""].join(
      "\n"
    )
    const res = await tool.handler({ patch }, {})
    assert.match(textOf(res), /created/)
    const abs = path.join(dir, "new.txt")
    const body = await fsp.readFile(abs, "utf-8")
    assert.match(body, /hello/)
    assert.match(body, /world/)
    assert.equal(tracker.hasRead(abs), true)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("refuses to create over an existing file", async () => {
  const dir = await tmp()
  const tool = createApplyPatchTool({ cwd: dir, readTracker: createReadTracker() })
  try {
    const abs = path.join(dir, "exists.txt")
    await fsp.writeFile(abs, "original\n")
    const patch = ["--- /dev/null", "+++ exists.txt", "@@ -0,0 +1,1 @@", "+new", ""].join("\n")
    const res = await tool.handler({ patch }, {})
    assert.equal(res.isError, true)
    assert.match(textOf(res), /refusing to create over an existing file/)
    assert.equal(await fsp.readFile(abs, "utf-8"), "original\n")
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("deletes a file via a /dev/null target hunk (after a read)", async () => {
  const dir = await tmp()
  const tracker = createReadTracker()
  const tool = createApplyPatchTool({ cwd: dir, readTracker: tracker })
  try {
    const abs = path.join(dir, "old.txt")
    await fsp.writeFile(abs, "hello\nworld\n")
    tracker.record(abs, await fsp.stat(abs))
    const patch = ["--- old.txt", "+++ /dev/null", "@@ -1,2 +0,0 @@", "-hello", "-world", ""].join(
      "\n"
    )
    const res = await tool.handler({ patch }, {})
    assert.match(textOf(res), /deleted/)
    await assert.rejects(fsp.stat(abs))
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("is atomic across files: a failing hunk writes nothing", async () => {
  const dir = await tmp()
  const tracker = createReadTracker()
  const tool = createApplyPatchTool({ cwd: dir, readTracker: tracker })
  try {
    const absA = path.join(dir, "a.txt")
    const absB = path.join(dir, "b.txt")
    await fsp.writeFile(absA, "a1\na2\n")
    await fsp.writeFile(absB, "b1\nb2\n")
    tracker.record(absA, await fsp.stat(absA))
    tracker.record(absB, await fsp.stat(absB))
    const good = createPatch("a.txt", "a1\na2\n", "a1\nA2\n")
    // A hunk whose context does NOT match b.txt's real content.
    const bad = ["--- b.txt", "+++ b.txt", "@@ -1,2 +1,2 @@", "-NOPE", "+changed", " b2", ""].join(
      "\n"
    )
    const res = await tool.handler({ patch: `${good}\n${bad}` }, {})
    assert.equal(res.isError, true)
    assert.match(textOf(res), /does not apply cleanly/)
    // Neither file changed — the good hunk was rolled back (never committed).
    assert.equal(await fsp.readFile(absA, "utf-8"), "a1\na2\n")
    assert.equal(await fsp.readFile(absB, "utf-8"), "b1\nb2\n")
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("preserves BOM and CRLF on modify", async () => {
  const dir = await tmp()
  const tracker = createReadTracker()
  const tool = createApplyPatchTool({ cwd: dir, readTracker: tracker })
  try {
    const abs = path.join(dir, "crlf.txt")
    await fsp.writeFile(abs, `${BOM}a\r\nb\r\nc\r\n`)
    tracker.record(abs, await fsp.stat(abs))
    // Patch authored against the LF-normalized view (mirrors how the model sees it).
    const patch = createPatch("crlf.txt", "a\nb\nc\n", "a\nB\nc\n")
    const res = await tool.handler({ patch }, {})
    assert.match(textOf(res), /updated/)
    assert.equal(await fsp.readFile(abs, "utf-8"), `${BOM}a\r\nB\r\nc\r\n`)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("rejects an empty / unparseable patch", async () => {
  const dir = await tmp()
  const tool = createApplyPatchTool({ cwd: dir, readTracker: createReadTracker() })
  try {
    const res = await tool.handler({ patch: "not a diff at all" }, {})
    assert.equal(res.isError, true)
    assert.match(textOf(res), /missing a target file path|no file patches found/)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("surfaces LSP diagnostics after a successful patch", async () => {
  const dir = await tmp()
  const tracker = createReadTracker()
  const lspResolver = {
    getDiagnostics: async () => [
      { severity: 1, range: { start: { line: 1, character: 0 } }, message: "boom" },
    ],
  }
  const tool = createApplyPatchTool({ cwd: dir, readTracker: tracker, lspResolver })
  try {
    const abs = path.join(dir, "foo.txt")
    await fsp.writeFile(abs, "a\nb\nc\n")
    tracker.record(abs, await fsp.stat(abs))
    const patch = createPatch("foo.txt", "a\nb\nc\n", "a\nB\nc\n")
    const res = await tool.handler({ patch }, {})
    assert.match(textOf(res), /Diagnostics after write/)
    assert.match(textOf(res), /boom/)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("fuzzy-rescues a hunk whose context drifted past strict apply", async () => {
  const dir = await tmp()
  const tracker = createReadTracker()
  const tool = createApplyPatchTool({ cwd: dir, readTracker: tracker })
  try {
    const abs = path.join(dir, "f.txt")
    // Disk has a 4-space-indented context line; the patch was authored against a
    // 2-space version — strict applyPatch rejects the drift, the rescue accepts it.
    await fsp.writeFile(abs, "alpha\n    beta\ngamma\n")
    tracker.record(abs, await fsp.stat(abs))
    const patch = createPatch("f.txt", "alpha\n  beta\ngamma\n", "alpha\n  beta\nGAMMA\n")
    const res = await tool.handler({ patch }, {})
    assert.match(textOf(res), /Applied patch to 1 file/)
    const out = await fsp.readFile(abs, "utf-8")
    assert.match(out, /GAMMA/)
    assert.doesNotMatch(out, /gamma/)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("refuses to rescue when the hunk context is nowhere in the file (nothing written)", async () => {
  const dir = await tmp()
  const tracker = createReadTracker()
  const tool = createApplyPatchTool({ cwd: dir, readTracker: tracker })
  try {
    const abs = path.join(dir, "f.txt")
    await fsp.writeFile(abs, "alpha\nbeta\n")
    tracker.record(abs, await fsp.stat(abs))
    // Removes a line that does not exist on disk — neither strict nor fuzzy can match.
    const patch = ["--- f.txt", "+++ f.txt", "@@ -1,1 +1,1 @@", "-zeta", "+ZETA", ""].join("\n")
    const res = await tool.handler({ patch }, {})
    assert.equal(res.isError, true)
    assert.match(textOf(res), /does not apply cleanly/)
    assert.equal(await fsp.readFile(abs, "utf-8"), "alpha\nbeta\n")
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test("preserves CRLF + BOM through a fuzzy-rescued hunk", async () => {
  const dir = await tmp()
  const tracker = createReadTracker()
  const tool = createApplyPatchTool({ cwd: dir, readTracker: tracker })
  try {
    const abs = path.join(dir, "f.txt")
    // CRLF + BOM on disk, with a trailing-space drift on the context line.
    await fsp.writeFile(abs, `${BOM}a\r\nbeta \r\nc\r\n`)
    tracker.record(abs, await fsp.stat(abs))
    const patch = createPatch("f.txt", "a\nbeta\nc\n", "a\nbeta\nC\n")
    const res = await tool.handler({ patch }, {})
    assert.match(textOf(res), /Applied patch to 1 file/)
    const out = await fsp.readFile(abs, "utf-8")
    assert.equal(out[0], BOM)
    assert.match(out, /\r\n/)
    assert.match(out, /C\r\n/)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})
