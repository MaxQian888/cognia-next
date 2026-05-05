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
      "history.fetch",
      "rich-markdown.telegram",
    ]
    for (const cap of required) {
      expect(TELEGRAM_CAPS).toContain(cap)
    }
  })

  it("has exactly 14 entries", () => {
    expect(TELEGRAM_CAPS).toHaveLength(14)
  })
})
