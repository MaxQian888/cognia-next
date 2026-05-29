import { QQ_OFFICIAL_A2UI_CAPABILITY, QQ_OFFICIAL_CAPS } from "./capability"
import { A2UI_COMPONENT_KINDS } from "@/types/connectors/capability"

describe("qq-official capability", () => {
  it("declares text + reply, but not markdown/media (honest about v1)", () => {
    expect(QQ_OFFICIAL_CAPS).toContain("send.text")
    expect(QQ_OFFICIAL_CAPS).toContain("send.reply")
    expect(QQ_OFFICIAL_CAPS).not.toContain("send.markdown")
    expect(QQ_OFFICIAL_CAPS).not.toContain("send.image")
    expect(QQ_OFFICIAL_CAPS).not.toContain("send.a2ui")
  })

  it("falls back every A2UI component to the plain-text mirror", () => {
    for (const kind of A2UI_COMPONENT_KINDS) {
      expect(QQ_OFFICIAL_A2UI_CAPABILITY[kind]).toBe("fallback")
    }
  })
})
