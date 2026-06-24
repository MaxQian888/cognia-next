import {
  DIAGNOSTICS_PART_TYPE,
  isSystemMessageBlock,
  isSlashCommandResultBlock,
} from "./system-blocks"

describe("DIAGNOSTICS_PART_TYPE", () => {
  it("is the data-diagnostics UI part carrier", () => {
    expect(DIAGNOSTICS_PART_TYPE).toBe("data-diagnostics")
  })
})

describe("isSystemMessageBlock", () => {
  it.each(["context", "cost", "usage"])("accepts the %s diagnostics block", (kind) => {
    expect(isSystemMessageBlock({ kind })).toBe(true)
  })

  it("rejects the slash-result block and unknown kinds", () => {
    expect(isSystemMessageBlock({ kind: "slash-result" })).toBe(false)
    expect(isSystemMessageBlock({ kind: "mystery" })).toBe(false)
  })

  it("rejects non-objects", () => {
    expect(isSystemMessageBlock(null)).toBe(false)
    expect(isSystemMessageBlock("context")).toBe(false)
    expect(isSystemMessageBlock(undefined)).toBe(false)
  })
})

describe("isSlashCommandResultBlock", () => {
  it("accepts a slash-result block", () => {
    expect(isSlashCommandResultBlock({ kind: "slash-result", commandId: "resume" })).toBe(true)
  })

  it("rejects diagnostics blocks and unknown kinds", () => {
    expect(isSlashCommandResultBlock({ kind: "context" })).toBe(false)
    expect(isSlashCommandResultBlock({ kind: "mystery" })).toBe(false)
  })

  it("rejects non-objects", () => {
    expect(isSlashCommandResultBlock(null)).toBe(false)
    expect(isSlashCommandResultBlock("slash-result")).toBe(false)
  })
})
