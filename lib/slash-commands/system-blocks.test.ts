import {
  DIAGNOSTICS_PART_TYPE,
  isSystemMessageBlock,
  isSlashCommandResultBlock,
  isVideoJobBlock,
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

describe("isVideoJobBlock", () => {
  it("accepts a block naming a job", () => {
    expect(isVideoJobBlock({ kind: "video-job", jobId: "vjob_1" })).toBe(true)
  })

  it("rejects a block without a job id, other kinds and non-objects", () => {
    expect(isVideoJobBlock({ kind: "video-job" })).toBe(false)
    expect(isVideoJobBlock({ kind: "video-job", jobId: "" })).toBe(false)
    expect(isVideoJobBlock({ kind: "slash-result", jobId: "vjob_1" })).toBe(false)
    expect(isVideoJobBlock(null)).toBe(false)
  })

  it("is not mistaken for a diagnostics card", () => {
    expect(isSystemMessageBlock({ kind: "video-job", jobId: "vjob_1" })).toBe(false)
  })
})
