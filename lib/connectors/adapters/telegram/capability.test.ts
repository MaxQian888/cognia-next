import { TELEGRAM_CAPS } from "./capability"

describe("TELEGRAM_CAPS", () => {
  it("is sorted alphabetically (stable diff)", () => {
    const sorted = [...TELEGRAM_CAPS].sort()
    expect([...TELEGRAM_CAPS]).toEqual(sorted)
  })

  it("includes the Phase-1 ship-set", () => {
    const required = [
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

  it("has exactly 13 entries", () => {
    expect(TELEGRAM_CAPS).toHaveLength(13)
  })
})
