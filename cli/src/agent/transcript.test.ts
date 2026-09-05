/**
 * @jest-environment node
 */
import path from "node:path"
import fs from "node:fs"
import os from "node:os"

import {
  appendTranscript,
  readTranscript,
  sessionTranscriptPath,
  writeTranscript,
  type TranscriptFs,
} from "./transcript"

const HOME = "/home/u/.cognia"

function memFs() {
  const files = new Map<string, string>()
  const dirs: string[] = []
  const fsx: TranscriptFs = {
    append: (p, line) => files.set(p, (files.get(p) ?? "") + line),
    read: (p) => (files.has(p) ? files.get(p)! : null),
    mkdirp: (d) => void dirs.push(d),
    write: (p, content) => files.set(p, content),
  }
  return { fsx, files, dirs }
}

describe("transcript", () => {
  it("round-trips the native store and distinguishes missing files from I/O errors", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-transcript-check-"))
    try {
      expect(readTranscript(home, "absent")).toEqual([])
      appendTranscript(home, "native", { ts: 3, role: "user", content: "original" })
      expect(readTranscript(home, "native")[0].content).toBe("original")
      writeTranscript(home, "native", [{ ts: 4, role: "assistant", content: "replacement" }])
      expect(readTranscript(home, "native")[0].content).toBe("replacement")
      fs.mkdirSync(sessionTranscriptPath(home, "directory"))
      expect(() => readTranscript(home, "directory")).toThrow()
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it("appends entries and reads them back in order", () => {
    const m = memFs()
    appendTranscript(HOME, "s1", { role: "user", content: "hi" }, m.fsx, 1000)
    appendTranscript(HOME, "s1", { role: "assistant", content: "hello" }, m.fsx, 1001)
    const entries = readTranscript(HOME, "s1", m.fsx)
    expect(entries).toEqual([
      { ts: 1000, role: "user", content: "hi" },
      { ts: 1001, role: "assistant", content: "hello" },
    ])
  })

  it("creates the sessions dir before writing", () => {
    const m = memFs()
    appendTranscript(HOME, "s1", { role: "user", content: "x" }, m.fsx, 1)
    expect(m.dirs[0]).toBe(path.dirname(sessionTranscriptPath(HOME, "s1")))
  })

  it("persists meta when provided", () => {
    const m = memFs()
    appendTranscript(
      HOME,
      "s1",
      { role: "assistant", content: "ok", meta: { usage: { totalTokens: 5 } } },
      m.fsx,
      1
    )
    expect(readTranscript(HOME, "s1", m.fsx)[0].meta).toEqual({ usage: { totalTokens: 5 } })
  })

  it("returns [] for a missing transcript", () => {
    expect(readTranscript(HOME, "missing", memFs().fsx)).toEqual([])
  })

  it("skips corrupt lines on read", () => {
    const m = memFs()
    m.files.set(sessionTranscriptPath(HOME, "s1"), '{"ts":1,"role":"user","content":"a"}\n{bad\n')
    expect(readTranscript(HOME, "s1", m.fsx)).toEqual([{ ts: 1, role: "user", content: "a" }])
  })

  it("skips valid JSON that is not a transcript entry", () => {
    const m = memFs()
    const invalid = [
      null,
      [],
      1,
      "text",
      {},
      { ts: 1, role: "tool", content: "bad" },
      { ts: "yesterday", role: "user", content: "bad" },
      { ts: 1, role: "user", content: null },
      { ts: 1, role: "assistant", content: 5 },
    ]
    const kept = { ts: 2, role: "user", content: "recoverable history" }
    m.files.set(
      sessionTranscriptPath(HOME, "s1"),
      [...invalid, kept].map((value) => JSON.stringify(value)).join("\n")
    )
    expect(readTranscript(HOME, "s1", m.fsx)).toEqual([kept])
  })

  it("writeTranscript overwrites with the given entries (round-trips)", () => {
    const m = memFs()
    appendTranscript(HOME, "s1", { role: "user", content: "old1" }, m.fsx, 1)
    appendTranscript(HOME, "s1", { role: "assistant", content: "old2" }, m.fsx, 2)
    writeTranscript(HOME, "s1", [{ ts: 1, role: "user", content: "kept" }], m.fsx)
    expect(readTranscript(HOME, "s1", m.fsx)).toEqual([{ ts: 1, role: "user", content: "kept" }])
  })

  it("writeTranscript with [] clears the file", () => {
    const m = memFs()
    appendTranscript(HOME, "s1", { role: "user", content: "x" }, m.fsx, 1)
    writeTranscript(HOME, "s1", [], m.fsx)
    expect(readTranscript(HOME, "s1", m.fsx)).toEqual([])
  })
})
