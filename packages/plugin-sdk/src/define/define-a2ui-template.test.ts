import { defineA2UITemplate } from "./define-a2ui-template"

describe("defineA2UITemplate", () => {
  it("returns the template contribution unchanged", () => {
    const def = {
      id: "research-brief",
      name: "Research Brief",
      description: "A structured research output.",
      surfaceType: "panel" as const,
      components: [],
    }

    expect(defineA2UITemplate(def)).toBe(def)
  })
})
