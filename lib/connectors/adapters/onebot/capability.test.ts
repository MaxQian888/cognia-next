import { ONEBOT_CAPS } from "./capability"

describe("ONEBOT_CAPS", () => {
  it("is sorted alphabetically (stable diff)", () => {
    const sorted = [...ONEBOT_CAPS].sort()
    expect([...ONEBOT_CAPS]).toEqual(sorted)
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
      "send.emoji",
      "delete",
      "history.fetch",
    ]
    for (const cap of required) {
      expect(ONEBOT_CAPS).toContain(cap)
    }
  })

  it("does NOT include edit or typing (OneBot lacks native support)", () => {
    expect(ONEBOT_CAPS).not.toContain("edit")
    expect(ONEBOT_CAPS).not.toContain("typing")
  })

  it("has exactly 11 entries", () => {
    expect(ONEBOT_CAPS).toHaveLength(11)
  })
})
