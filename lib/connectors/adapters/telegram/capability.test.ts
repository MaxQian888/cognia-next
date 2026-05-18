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

  it("includes send.reaction (A1 / setMessageReaction)", () => {
    // ADR-0009 v41 / A1: parity with Slack + Lark reaction-send capability.
    // Bot API 7.0+ exposes setMessageReaction; bots may push emoji
    // ReactionType (custom_emoji is admin-gated).
    expect(TELEGRAM_CAPS).toContain("send.reaction")
  })

  it("has exactly 15 entries (13 Phase-1 + send.a2ui + send.reaction)", () => {
    expect(TELEGRAM_CAPS).toHaveLength(15)
  })
})
