import { WECHAT_OA_A2UI_CAPABILITY, WECHAT_OA_CAPS } from "./capability"
import { A2UI_COMPONENT_KINDS } from "@/types/connectors/capability"

describe("wechat-oa capability", () => {
  it("declares the wired customer-service media types", () => {
    expect(WECHAT_OA_CAPS).toEqual([
      "send.text",
      "send.image",
      "send.voice",
      "send.video",
      "typing",
    ])
  })
  it("falls back every A2UI component to the text mirror", () => {
    for (const kind of A2UI_COMPONENT_KINDS) {
      expect(WECHAT_OA_A2UI_CAPABILITY[kind]).toBe("fallback")
    }
  })
})
