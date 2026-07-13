import { WECOM_CAPS, WECOM_A2UI_CAPABILITY } from "./capability"

describe("WeCom capability declarations", () => {
  it("declares the supported send capabilities", () => {
    expect(WECOM_CAPS).toEqual(
      expect.arrayContaining([
        "send.text",
        "send.markdown",
        "send.image",
        "send.voice",
        "send.video",
        "send.file",
        "send.card",
        "send.a2ui",
      ])
    )
  })

  it("does not claim edit / delete / typing / history.fetch", () => {
    expect(WECOM_CAPS).not.toContain("edit")
    expect(WECOM_CAPS).not.toContain("delete")
    expect(WECOM_CAPS).not.toContain("typing")
    expect(WECOM_CAPS).not.toContain("history.fetch")
  })

  it("maps Button + card-header primitives native, interactive form controls fallback", () => {
    expect(WECOM_A2UI_CAPABILITY.Button).toBe("native")
    expect(WECOM_A2UI_CAPABILITY.Text).toBe("native")
    expect(WECOM_A2UI_CAPABILITY.Card).toBe("native")
    expect(WECOM_A2UI_CAPABILITY.Alert).toBe("native")
    // No native template-card analogue → degrade to plainTextMirror.
    expect(WECOM_A2UI_CAPABILITY.Select).toBe("fallback")
    expect(WECOM_A2UI_CAPABILITY.TextField).toBe("fallback")
    expect(WECOM_A2UI_CAPABILITY.Checkbox).toBe("fallback")
  })

  it("does not over-claim: Image / Link / Divider / Badge are never projected into a template_card", () => {
    expect(WECOM_A2UI_CAPABILITY.Image).toBe("fallback")
    expect(WECOM_A2UI_CAPABILITY.Link).toBe("fallback")
    expect(WECOM_A2UI_CAPABILITY.Divider).toBe("fallback")
    expect(WECOM_A2UI_CAPABILITY.Badge).toBe("fallback")
  })
})
