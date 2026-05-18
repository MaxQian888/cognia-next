import { DISCORD_A2UI_CAPABILITY, DISCORD_CAPS } from "./capability"

describe("DISCORD_CAPS", () => {
  it("is sorted alphabetically (stable diff)", () => {
    const sorted = [...DISCORD_CAPS].sort()
    expect([...DISCORD_CAPS]).toEqual(sorted)
  })

  it("includes the G3.2 ship-set (with send.voice + send.video)", () => {
    const required = [
      "send.a2ui",
      "send.text",
      "send.markdown",
      "send.image",
      "send.file",
      "send.reply",
      "send.mention",
      "send.thread",
      "send.voice",
      "send.video",
      "edit",
      "delete",
      "typing",
    ]
    for (const cap of required) {
      expect(DISCORD_CAPS).toContain(cap)
    }
  })

  it("has exactly 13 entries (Phase-1 + send.a2ui + send.voice + send.video)", () => {
    expect(DISCORD_CAPS).toHaveLength(13)
  })
})

describe("DISCORD_A2UI_CAPABILITY", () => {
  it("declares Button + Select + Card native", () => {
    expect(DISCORD_A2UI_CAPABILITY.Button).toBe("native")
    expect(DISCORD_A2UI_CAPABILITY.Select).toBe("native")
    expect(DISCORD_A2UI_CAPABILITY.Card).toBe("native")
    expect(DISCORD_A2UI_CAPABILITY.Image).toBe("native")
  })

  it("declares Chart / Table as fallback (no native rendering)", () => {
    expect(DISCORD_A2UI_CAPABILITY.Chart).toBe("fallback")
    expect(DISCORD_A2UI_CAPABILITY.Table).toBe("fallback")
  })

  it("declares form controls as fallback (modals are interaction-launched)", () => {
    expect(DISCORD_A2UI_CAPABILITY.TextField).toBe("fallback")
    expect(DISCORD_A2UI_CAPABILITY.TextArea).toBe("fallback")
    expect(DISCORD_A2UI_CAPABILITY.Checkbox).toBe("fallback")
  })
})
