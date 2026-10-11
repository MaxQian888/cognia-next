import { defineGlanceModule } from "./define-glance-module"

describe("defineGlanceModule", () => {
  it("returns the module declaration unchanged (pure pass-through)", () => {
    const def = defineGlanceModule({
      id: "builds",
      title: "Builds",
      titleKey: "glance.builds",
      icon: "Hammer",
      sizes: ["compact", "standard"],
      platforms: ["desktop", "mobile"],
    })
    expect(def).toEqual({
      id: "builds",
      title: "Builds",
      titleKey: "glance.builds",
      icon: "Hammer",
      sizes: ["compact", "standard"],
      platforms: ["desktop", "mobile"],
    })
  })

  it("does not copy the input", () => {
    const input = { id: "deploys", title: "Deploys" }
    expect(defineGlanceModule(input)).toBe(input)
  })
})
