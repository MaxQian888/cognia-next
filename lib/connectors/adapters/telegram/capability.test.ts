import { TELEGRAM_CAPS } from "./capability"

describe("TELEGRAM_CAPS", () => {
  it("is sorted alphabetically (stable diff)", () => {
    const sorted = [...TELEGRAM_CAPS].sort()
    expect([...TELEGRAM_CAPS]).toEqual(sorted)
  })

  it("includes the Phase-1 ship-set plus send.a2ui (Group 1 addition)", () => {
    const required = [
      "send.a2ui",
      "send.text",
      "send.markdown",
      "send.image",
      "send.voice",
      "send.video",
      "send.file",
      "send.reply",
      "send.mention",
      "send.thread",
      "edit",
      "delete",
      "typing",
      "rich-markdown.telegram",
    ]
    for (const cap of required) {
      expect(TELEGRAM_CAPS).toContain(cap)
    }
  })

  it("does NOT include history.fetch (Bot API does not expose chat history)", () => {
    expect(TELEGRAM_CAPS).not.toContain("history.fetch")
  })

  it("has exactly 14 entries (13 Phase-1 + send.a2ui)", () => {
    expect(TELEGRAM_CAPS).toHaveLength(14)
  })
})
