import { DISCORD_CAPS } from "./capability"

describe("DISCORD_CAPS", () => {
  it("is sorted alphabetically (stable diff)", () => {
    const sorted = [...DISCORD_CAPS].sort()
    expect([...DISCORD_CAPS]).toEqual(sorted)
  })

  it("includes the Phase-1 ship-set", () => {
    const required = [
      "send.text",
      "send.markdown",
      "send.image",
      "send.file",
      "send.reply",
      "send.mention",
      "send.thread",
      "edit",
      "delete",
      "typing",
    ]
    for (const cap of required) {
      expect(DISCORD_CAPS).toContain(cap)
    }
  })

  it("does NOT include send.voice (Phase 2)", () => {
    expect(DISCORD_CAPS).not.toContain("send.voice")
  })

  it("has exactly 10 entries", () => {
    expect(DISCORD_CAPS).toHaveLength(10)
  })
})
