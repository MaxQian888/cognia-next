import { SETTING_CONTROLS } from "./control-registry"
import { SETTINGS_NAV } from "@/components/settings/settings-nav-config"

const VALID_SECTIONS = new Set(SETTINGS_NAV.map((n) => n.id))

describe("SETTING_CONTROLS registry", () => {
  it("has unique control ids", () => {
    const ids = SETTING_CONTROLS.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("references only real settings sections", () => {
    for (const c of SETTING_CONTROLS) {
      expect(VALID_SECTIONS.has(c.sectionId)).toBe(true)
    }
  })

  it("gives every control a label key", () => {
    for (const c of SETTING_CONTROLS) {
      expect(typeof c.labelKey).toBe("string")
      expect(c.labelKey.length).toBeGreaterThan(0)
    }
  })

  it("is a curated subset (documented, not exhaustive)", () => {
    // Guards against accidental emptiness without pretending to be complete.
    expect(SETTING_CONTROLS.length).toBeGreaterThanOrEqual(15)
  })
})
