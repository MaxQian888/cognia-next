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

  it("returns [] for an empty transcript", () => {
    expect(transcriptToCells([])).toEqual([])
  })
})
