import { SLACK_A2UI_CAPABILITY, SLACK_CAPS } from "./capability"
import { ALL_CAPABILITIES } from "@/types/connectors/capability"

describe("SLACK_CAPS", () => {
  it("is a readonly array", () => {
    expect(Array.isArray(SLACK_CAPS)).toBe(true)
  })

  it("declares the Phase-1 capability set plus send.a2ui (Group 1 addition)", () => {
    const expected = [
      "delete",
      "edit",
      "history.fetch",
      "rich-card.slack",
      "rich-markdown.slack",
      "send.a2ui",
      "send.card",
      "send.file",
      "send.image",
      "send.markdown",
      "send.mention",
      "send.reaction",
      "send.reply",
      "send.text",
      "send.thread",
    ]
    expect([...SLACK_CAPS].sort()).toEqual([...expected].sort())
  })

  it("every declared capability is a known Capability value", () => {
    for (const cap of SLACK_CAPS) {
      expect(ALL_CAPABILITIES).toContain(cap)
    }
  })

  it("is sorted alphabetically", () => {
    const sorted = [...SLACK_CAPS].sort()
    expect([...SLACK_CAPS]).toEqual(sorted)
  })

  it("does not include send.typing (not a native bot API in Phase 1)", () => {
    expect(SLACK_CAPS).not.toContain("typing")
  })
})

describe("SLACK_A2UI_CAPABILITY", () => {
  it("declares the form-control family native (Slack Block Kit is the richest)", () => {
    expect(SLACK_A2UI_CAPABILITY.Button).toBe("native")
    expect(SLACK_A2UI_CAPABILITY.Select).toBe("native")
    expect(SLACK_A2UI_CAPABILITY.RadioGroup).toBe("native")
    expect(SLACK_A2UI_CAPABILITY.Checkbox).toBe("native")
    expect(SLACK_A2UI_CAPABILITY.TextField).toBe("native")
    expect(SLACK_A2UI_CAPABILITY.TextArea).toBe("native")
    expect(SLACK_A2UI_CAPABILITY.DatePicker).toBe("native")
    expect(SLACK_A2UI_CAPABILITY.TimePicker).toBe("native")
  })

  it("declares display family native", () => {
    expect(SLACK_A2UI_CAPABILITY.Text).toBe("native")
    expect(SLACK_A2UI_CAPABILITY.Image).toBe("native")
    expect(SLACK_A2UI_CAPABILITY.Card).toBe("native")
    expect(SLACK_A2UI_CAPABILITY.Alert).toBe("native")
    expect(SLACK_A2UI_CAPABILITY.Divider).toBe("native")
  })

  it("declares data widgets as fallback (no native Block Kit equivalent)", () => {
    expect(SLACK_A2UI_CAPABILITY.Chart).toBe("fallback")
    expect(SLACK_A2UI_CAPABILITY.Table).toBe("fallback")
    expect(SLACK_A2UI_CAPABILITY.Slider).toBe("fallback")
  })
})
