/**
 * @jest-environment node
 */
import path from "node:path"

import {
  appendTranscript,
  readTranscript,
  sessionTranscriptPath,
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
  }
  return { fsx, files, dirs }
}

describe("transcript", () => {
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
})
