import { buildConfirmSurface } from "./confirm-surface"

describe("buildConfirmSurface (shared HITL card)", () => {
  it("builds a Card with summary, detail rows, and confirm/cancel buttons", () => {
    const surface = buildConfirmSurface({
      surfaceId: "sfc_x",
      title: "Do thing",
      summary: "This will do the thing.",
      details: [{ label: "Target", value: "oc_1" }],
    })
    expect(surface.rootId).toBe("sfc_x")
    expect(surface.title).toBe("Do thing")
    const components = surface.components as Record<string, { component: string; props?: unknown }>
    expect(components.sfc_x.component).toBe("Card")
    expect(components.summary.props).toEqual({ text: "This will do the thing." })
    expect(components.detail_0.props).toEqual({ text: "**Target**: oc_1" })
    expect(components.btn_confirm.props).toMatchObject({
      label: "Confirm",
      action: { type: "button", value: "confirm" },
    })
    expect(components.btn_cancel.props).toMatchObject({
      action: { type: "button", value: "cancel" },
    })
  })

  it("stays importable from the legacy lark helper path (re-export)", async () => {
    const legacy = await import("../lark/_helpers")
    expect(legacy.buildConfirmSurface).toBe(buildConfirmSurface)
  })
})
