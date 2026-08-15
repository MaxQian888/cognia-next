import type { UIMessage } from "ai"
import {
  VIRTUALIZE_TEXT_BYTES_THRESHOLD,
  VIRTUALIZE_THRESHOLD,
  shouldVirtualize,
  shouldVirtualizeMessages,
  transcriptTextLength,
} from "./virtualization-threshold"

const msg = (id: string, parts: unknown[]): UIMessage =>
  ({ id, role: "assistant", parts }) as unknown as UIMessage

describe("virtualization-threshold (ADR-0127 §3)", () => {
  it("keeps the historical count trigger", () => {
    expect(VIRTUALIZE_THRESHOLD).toBe(40)
    expect(shouldVirtualize({ rowCount: 40, textLength: 0 })).toBe(false)
    expect(shouldVirtualize({ rowCount: 41, textLength: 0 })).toBe(true)
  })

  it("adds a total-text trigger so a few huge messages still virtualize", () => {
    expect(VIRTUALIZE_TEXT_BYTES_THRESHOLD).toBe(256 * 1024)
    expect(shouldVirtualize({ rowCount: 3, textLength: VIRTUALIZE_TEXT_BYTES_THRESHOLD })).toBe(
      false
    )
    expect(shouldVirtualize({ rowCount: 3, textLength: VIRTUALIZE_TEXT_BYTES_THRESHOLD + 1 })).toBe(
      true
    )
  })

  it("sums text, reasoning and string tool payloads but ignores non-string payloads", () => {
    const messages = [
      msg("a", [
        { type: "text", text: "hello" },
        { type: "reasoning", text: "why" },
        { type: "tool-Bash", input: "ls -la", output: "file" },
        { type: "tool-Read", input: { path: "x" }, output: { lines: 3 } },
        { type: "file", url: "cognia-media:abc" },
        null,
      ]),
      msg("b", []),
      { id: "c", role: "user" } as unknown as UIMessage,
    ]
    // "hello"(5) + "why"(3) + "ls -la"(6) + "file"(4)
    expect(transcriptTextLength(messages)).toBe(18)
  })

  it("shouldVirtualizeMessages counts synthetic extra rows and total text", () => {
    const small = Array.from({ length: 5 }, (_, i) => msg(`m${i}`, [{ type: "text", text: "x" }]))
    expect(shouldVirtualizeMessages(small)).toBe(false)
    // 39 messages of 8 KB each = 312 KB > 256 KB, well under the count trigger.
    const heavy = Array.from({ length: 39 }, (_, i) =>
      msg(`h${i}`, [{ type: "text", text: "y".repeat(8 * 1024) }])
    )
    expect(shouldVirtualizeMessages(heavy)).toBe(true)
    // 40 tiny messages + 1 synthetic thinking row crosses the count trigger.
    const forty = Array.from({ length: 40 }, (_, i) => msg(`f${i}`, [{ type: "text", text: "z" }]))
    expect(shouldVirtualizeMessages(forty)).toBe(false)
    expect(shouldVirtualizeMessages(forty, 1)).toBe(true)
  })
})
