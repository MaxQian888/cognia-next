import { defineA2UIComponent } from "./define-a2ui-component"

describe("defineA2UIComponent", () => {
  it("returns the component contribution unchanged", () => {
    const def = {
      type: "summary.card",
      name: "Summary Card",
      description: "Renders a compact summary.",
      propsSchema: { type: "object" },
    }

    expect(defineA2UIComponent(def)).toBe(def)
  })
})
