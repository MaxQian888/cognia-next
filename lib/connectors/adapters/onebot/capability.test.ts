import { ONEBOT_CAPS } from "./capability"

describe("ONEBOT_CAPS", () => {
  it("is sorted alphabetically (stable diff)", () => {
    const sorted = [...ONEBOT_CAPS].sort()
    expect([...ONEBOT_CAPS]).toEqual(sorted)
  })

  it("includes the Phase-1 ship-set (minus send.markdown) plus send.a2ui", () => {
    const required = [
      "send.a2ui",
      "send.text",
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

  it("does NOT include edit, typing, or send.markdown (OneBot lacks native support; markdown degrades silently)", () => {
    expect(ONEBOT_CAPS).not.toContain("edit")
    expect(ONEBOT_CAPS).not.toContain("typing")
    // send.markdown is dropped per the A2UI ⇄ IM plan (Group 1 / 3.5):
    // OneBot has no native markdown renderer and the prior "degrade
    // silently to text" behaviour conflicts with the capability-aware
    // downgrade contract.
    expect(ONEBOT_CAPS).not.toContain("send.markdown")
  })

  it("has exactly 11 entries (removed send.markdown, added send.a2ui)", () => {
    expect(ONEBOT_CAPS).toHaveLength(11)
  })
})
