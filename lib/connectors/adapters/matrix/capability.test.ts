import { MATRIX_A2UI_CAPABILITY, MATRIX_CAPS } from "./capability"
import { A2UI_COMPONENT_KINDS } from "@/types/connectors/capability"

describe("matrix capability", () => {
  it("declares core text + mutation capabilities", () => {
    expect(MATRIX_CAPS).toContain("send.text")
    expect(MATRIX_CAPS).toContain("send.markdown")
    expect(MATRIX_CAPS).toContain("send.reply")
    expect(MATRIX_CAPS).toContain("send.thread")
    expect(MATRIX_CAPS).toContain("send.reaction")
    expect(MATRIX_CAPS).toContain("send.a2ui")
    expect(MATRIX_CAPS).toContain("edit")
    expect(MATRIX_CAPS).toContain("delete")
    expect(MATRIX_CAPS).toContain("typing")
  })

  it("does not claim native media upload (honest about Phase 1)", () => {
    expect(MATRIX_CAPS).not.toContain("send.image")
    expect(MATRIX_CAPS).not.toContain("send.file")
  })

  it("covers every A2UI component kind in the matrix", () => {
    for (const kind of A2UI_COMPONENT_KINDS) {
      expect(MATRIX_A2UI_CAPABILITY[kind]).toBeDefined()
    }
  })

  it("renders rich text natively and forms via reply-correlation", () => {
    expect(MATRIX_A2UI_CAPABILITY.Text).toBe("native")
    expect(MATRIX_A2UI_CAPABILITY.Card).toBe("native")
    expect(MATRIX_A2UI_CAPABILITY.Alert).toBe("native")
    expect(MATRIX_A2UI_CAPABILITY.Button).toBe("simulated")
    expect(MATRIX_A2UI_CAPABILITY.Select).toBe("simulated")
    expect(MATRIX_A2UI_CAPABILITY.TextField).toBe("simulated")
    expect(MATRIX_A2UI_CAPABILITY.Image).toBe("fallback")
    // Unmentioned data widgets default to fallback.
    expect(MATRIX_A2UI_CAPABILITY.Chart).toBe("fallback")
    expect(MATRIX_A2UI_CAPABILITY.Table).toBe("fallback")
  })
})
