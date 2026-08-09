import { TAB_ICON_COMPONENTS } from "./tab-icon-map"
import { TAB_ICON_PRESETS } from "./tab-appearance"

describe("tab-icon-map", () => {
  it("exports a component (or null) for every icon preset", () => {
    for (const preset of TAB_ICON_PRESETS) {
      const entry = TAB_ICON_COMPONENTS[preset]
      if (preset === "none") {
        expect(entry).toBeNull()
      } else {
        // lucide-react components are ForwardRefExoticComponent (object with render)
        expect(entry).not.toBeNull()
        expect(typeof entry === "function" || typeof entry === "object").toBe(true)
      }
    }
  })

  it("has exactly one entry per preset", () => {
    const keys = Object.keys(TAB_ICON_COMPONENTS)
    expect(keys.sort()).toEqual([...TAB_ICON_PRESETS].sort())
  })
})
