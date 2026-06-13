// Most of this module is type-only (interfaces, type aliases). The single
// runtime export is `DEFAULT_BACKUP_AUTO_SCHEDULE`, so we sanity-check its
// shape so the file isn't excluded from the coverage corpus.

import { DEFAULT_BACKUP_AUTO_SCHEDULE, isPluginToolExecEvent } from "./types"
import type { ClaudeEvent, SendContentBlock } from "./types"

describe("SendContentBlock", () => {
  it("accepts text, image, and document base64 blocks", () => {
    const blocks: SendContentBlock[] = [
      { type: "text", text: "hi" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: "JVBER" },
      },
    ]
    const doc = blocks[2]
    expect(doc.type).toBe("document")
    if (doc.type === "document") {
      expect(doc.source.media_type).toBe("application/pdf")
    }
  })
})

describe("PluginToolExecEvent", () => {
  it("is narrowed by isPluginToolExecEvent and excluded otherwise", () => {
    const evt: ClaudeEvent = {
      type: "plugin_tool_exec",
      sessionId: "s1",
      toolUseId: "t1",
      name: "mcp__cognia-plugin-tools__sandbox_bash",
      args: { command: "echo hi" },
    }
    expect(isPluginToolExecEvent(evt)).toBe(true)
    const other: ClaudeEvent = { type: "ready" } as ClaudeEvent
    expect(isPluginToolExecEvent(other)).toBe(false)
  })
})

describe("DEFAULT_BACKUP_AUTO_SCHEDULE", () => {
  it("exposes the documented defaults", () => {
    expect(DEFAULT_BACKUP_AUTO_SCHEDULE.enabled).toBe(false)
    expect(DEFAULT_BACKUP_AUTO_SCHEDULE.intervalDays).toBe(7)
    expect(DEFAULT_BACKUP_AUTO_SCHEDULE.retainCount).toBe(5)
    expect(DEFAULT_BACKUP_AUTO_SCHEDULE.dirPath).toBeUndefined()
  })

  it("intervalDays sits inside the documented 1..30 range", () => {
    expect(DEFAULT_BACKUP_AUTO_SCHEDULE.intervalDays).toBeGreaterThanOrEqual(1)
    expect(DEFAULT_BACKUP_AUTO_SCHEDULE.intervalDays).toBeLessThanOrEqual(30)
  })
})
