import { WECHAT_PERSONAL_CAPS, WECHAT_PERSONAL_A2UI_CAPABILITY } from "./capability"

describe("personal-WeChat capability declarations", () => {
  it("declares text + a2ui only (plain-text channel)", () => {
    expect([...WECHAT_PERSONAL_CAPS].sort()).toEqual(["send.a2ui", "send.text"])
  })

  it("does not claim markdown / media / card / edit", () => {
    for (const cap of ["send.markdown", "send.image", "send.card", "edit"] as const) {
      expect(WECHAT_PERSONAL_CAPS).not.toContain(cap)
    }
  })

  it("renders Text native; every interactive component degrades to text", () => {
    expect(WECHAT_PERSONAL_A2UI_CAPABILITY.Text).toBe("native")
    expect(WECHAT_PERSONAL_A2UI_CAPABILITY.Button).toBe("fallback")
    expect(WECHAT_PERSONAL_A2UI_CAPABILITY.Select).toBe("fallback")
  })
})
