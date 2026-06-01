import { DINGTALK_CAPS, DINGTALK_A2UI_CAPABILITY } from "./capability"
import { A2UI_COMPONENT_KINDS } from "@/types/connectors/capability"

describe("dingtalk capability", () => {
  it("declares the markdown-first capability set and no edit/delete/typing", () => {
    expect(DINGTALK_CAPS).toEqual(["send.a2ui", "send.markdown", "send.text"])
    expect(DINGTALK_CAPS).not.toContain("edit")
    expect(DINGTALK_CAPS).not.toContain("delete")
    expect(DINGTALK_CAPS).not.toContain("typing")
  })

  it("covers every A2UI component kind (unlisted default to fallback)", () => {
    for (const kind of A2UI_COMPONENT_KINDS) {
      expect(DINGTALK_A2UI_CAPABILITY[kind]).toBeDefined()
    }
  })

  it("renders text/markdown structural components natively and degrades inputs", () => {
    expect(DINGTALK_A2UI_CAPABILITY.Text).toBe("native")
    expect(DINGTALK_A2UI_CAPABILITY.Card).toBe("native")
    expect(DINGTALK_A2UI_CAPABILITY.Image).toBe("native")
    expect(DINGTALK_A2UI_CAPABILITY.Button).toBe("simulated")
    expect(DINGTALK_A2UI_CAPABILITY.Select).toBe("fallback")
    expect(DINGTALK_A2UI_CAPABILITY.TextField).toBe("fallback")
  })
})
