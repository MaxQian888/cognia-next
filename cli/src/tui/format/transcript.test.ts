/**
 * @jest-environment node
 */
import type { TranscriptEntry } from "../../agent/transcript"

import { transcriptToCells } from "./transcript"

describe("transcriptToCells", () => {
  it("maps user/assistant/system entries to cells with deterministic ids", () => {
    const entries: TranscriptEntry[] = [
      { ts: 1, role: "user", content: "hi" },
      { ts: 2, role: "assistant", content: "hello" },
      { ts: 3, role: "system", content: "resumed" },
    ]
    expect(transcriptToCells(entries)).toEqual([
      { id: "r0", kind: "user", text: "hi" },
      { id: "r1", kind: "assistant", raw: "hello" },
      { id: "r2", kind: "notice", message: "resumed" },
    ])
  })

  it("drops an interrupted turn that saved history but no text, and keeps one with text", () => {
    const entries: TranscriptEntry[] = [
      { ts: 1, role: "user", content: "build it" },
      { ts: 2, role: "assistant", content: "", meta: { interrupted: true } },
      { ts: 3, role: "user", content: "again" },
      { ts: 4, role: "assistant", content: "half done", meta: { interrupted: true } },
    ]
    expect(transcriptToCells(entries)).toEqual([
      { id: "r0", kind: "user", text: "build it" },
      { id: "r2", kind: "user", text: "again" },
      { id: "r3", kind: "assistant", raw: "half done" },
    ])
  })

  it("returns [] for an empty transcript", () => {
    expect(transcriptToCells([])).toEqual([])
  })
})
