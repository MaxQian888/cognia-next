import { LARK_CAPS, LARK_A2UI_CAPABILITY } from "./capability"

describe("LARK_CAPS", () => {
  it("contains all expected Phase-1 capabilities plus send.a2ui", () => {
    const expected = [
      "delete",
      "edit",
      "history.fetch",
      "pin",
      "presence.status",
      "rich-card.lark",
      "send.a2ui",
      "send.card",
      "send.ephemeral",
      "send.file",
      "send.image",
      "send.markdown",
      "send.mention",
      "send.reaction",
      "send.reply",
      "send.text",
      "send.thread",
      "send.video",
      "send.voice",
    ]
    for (const cap of expected) {
      expect(LARK_CAPS).toContain(cap)
    }
  })

  it("declares the four chat-management capabilities (W2 multi-bot)", () => {
    for (const cap of ["chat.create", "chat.members", "chat.update", "contact.resolve"]) {
      expect(LARK_CAPS).toContain(cap)
    }
  })

  it("does not include typing (no native typing for bots)", () => {
    expect(LARK_CAPS).not.toContain("typing")
  })

  it("is sorted alphabetically", () => {
    const sorted = [...LARK_CAPS].sort()
    expect([...LARK_CAPS]).toEqual(sorted)
  })

  it("does not contain duplicate entries", () => {
    const unique = new Set(LARK_CAPS)
    expect(unique.size).toBe(LARK_CAPS.length)
  })
})

it("declares implemented Card 2.0 controls without claiming full table interactions", () => {
  for (const kind of [
    "Checkbox",
    "TextArea",
    "DateTimePicker",
    "FormGroup",
    "Collapsible",
  ] as const) {
    expect(LARK_A2UI_CAPABILITY[kind]).toBe("native")
  }
  expect(LARK_A2UI_CAPABILITY.Table).toBe("simulated")
  expect(LARK_A2UI_CAPABILITY.Chart).toBe("simulated")
  expect(LARK_A2UI_CAPABILITY.Dialog).toBe("simulated")
})
