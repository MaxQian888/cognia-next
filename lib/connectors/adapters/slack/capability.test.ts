import { SLACK_CAPS } from "./capability"
import { ALL_CAPABILITIES } from "@/types/connectors/capability"

describe("SLACK_CAPS", () => {
  it("is a readonly array", () => {
    expect(Array.isArray(SLACK_CAPS)).toBe(true)
  })

  it("declares the expected Phase-1 capability set", () => {
    const expected = [
      "delete",
      "edit",
      "history.fetch",
      "rich-card.slack",
      "rich-markdown.slack",
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
