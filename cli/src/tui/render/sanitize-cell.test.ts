import { sanitizeCell } from "./sanitize-cell"
import type { Cell } from "../state/types"

describe("sanitizeCell", () => {
  it("removes screen control sequences from nested untrusted strings", () => {
    const cell: Cell = {
      id: "tool",
      kind: "tool",
      callKey: "call",
      toolName: "read\u001b[2J",
      input: { path: "safe\u001b]8;;javascript:bad\u0007label" },
      result: { output: "hello\u001b[Hworld" },
      status: "done",
      collapsed: false,
    }
    const sanitized = sanitizeCell(cell)
    expect(JSON.stringify(sanitized)).not.toContain("\u001b")
    expect(sanitized).not.toBe(cell)
    expect(sanitizeCell(cell)).toBe(sanitized)
  })
})
