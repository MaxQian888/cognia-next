import { WECHAT_PERSONAL_CAPS, WECHAT_PERSONAL_A2UI_CAPABILITY } from "./capability"

describe("personal-WeChat capability declarations", () => {
  it("declares text, A2UI, and implemented media", () => {
    expect([...WECHAT_PERSONAL_CAPS].sort()).toEqual([
      "send.a2ui",
      "send.file",
      "send.image",
      "send.text",
      "send.video",
    ])
  })

  it("does not claim markdown / native voice / card / edit", () => {
    for (const cap of ["send.markdown", "send.voice", "send.card", "edit"] as const) {
      expect(WECHAT_PERSONAL_CAPS).not.toContain(cap)
    }
  })

  it("renders Text natively and simulates Button via numeric replies", () => {
    expect(WECHAT_PERSONAL_A2UI_CAPABILITY.Text).toBe("native")
    expect(WECHAT_PERSONAL_A2UI_CAPABILITY.Button).toBe("simulated")
    expect(WECHAT_PERSONAL_A2UI_CAPABILITY.Select).toBe("fallback")
  })
})

it("keeps implemented personal media available in effective private capabilities", () => {
  const { effectiveCapabilities } = jest.requireActual("@/lib/connectors/effective-capabilities")
  expect(
    effectiveCapabilities({ platform: "wechat-personal", scopeKind: "private" }).capabilities
  ).toEqual(expect.arrayContaining(["send.image", "send.video", "send.file"]))
})
