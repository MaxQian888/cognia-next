/** @jest-environment node */
import { cellDensity, needsBlankAfter } from "./transcript-spacing"
import type { Cell } from "../state/types"

const user: Cell = { id: "u", kind: "user", text: "hi" }
const assistant: Cell = { id: "a", kind: "assistant", raw: "there" }
const notice: Cell = { id: "n", kind: "notice", message: "note" }
const event: Cell = {
  id: "e",
  kind: "canonical-event",
  level: "info",
  title: "informational",
  summary: "External event",
}
const tool: Cell = {
  id: "t",
  kind: "tool",
  callKey: "k",
  toolName: "read",
  input: {},
  status: "done",
}
const collapsedThinking: Cell = { id: "th", kind: "thinking", text: "...", collapsed: true }
const openThinking: Cell = { id: "th2", kind: "thinking", text: "...", collapsed: false }

describe("cellDensity", () => {
  it("treats status lines as rows and everything else as a paragraph", () => {
    expect(cellDensity(tool)).toBe("row")
    expect(cellDensity(notice)).toBe("row")
    expect(cellDensity(event)).toBe("row")
    expect(cellDensity(user)).toBe("block")
    expect(cellDensity(assistant)).toBe("block")
  })

  it("follows the thinking cell's own disclosure state", () => {
    // Collapsed it is one line of status. Expanded it is a wall of reasoning
    // that needs separating from the reply underneath it.
    expect(cellDensity(collapsedThinking)).toBe("row")
    expect(cellDensity(openThinking)).toBe("block")
  })
})

describe("needsBlankAfter", () => {
  it("packs two adjacent rows together", () => {
    expect(needsBlankAfter(tool, tool)).toBe(false)
    expect(needsBlankAfter(tool, notice)).toBe(false)
    expect(needsBlankAfter(notice, event)).toBe(false)
  })

  it("separates a paragraph from whatever is on either side of it", () => {
    expect(needsBlankAfter(user, tool)).toBe(true)
    expect(needsBlankAfter(tool, assistant)).toBe(true)
    expect(needsBlankAfter(assistant, user)).toBe(true)
  })

  it("always ends the transcript with a blank, so it never touches the composer", () => {
    expect(needsBlankAfter(tool, undefined)).toBe(true)
    expect(needsBlankAfter(assistant, undefined)).toBe(true)
  })
})
