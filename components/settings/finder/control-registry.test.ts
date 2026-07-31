import { SETTING_CONTROLS } from "./control-registry"
import { SETTINGS_NAV } from "@/components/settings/settings-nav-config"
import enFinder from "@/i18n/messages/en/settings/finder.json"
import zhFinder from "@/i18n/messages/zh-CN/settings/finder.json"

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

  // Regression guard: the finder renders `settings.finder.controls.<labelKey>`,
  // which throws MISSING_MESSAGE at runtime if the translation is absent. A
  // string labelKey is not enough — it must resolve in BOTH locales.
  it.each([
    ["en", enFinder.controls],
    ["zh-CN", zhFinder.controls],
  ])("resolves every control labelKey in %s finder messages", (_locale, controls) => {
    for (const c of SETTING_CONTROLS) {
      expect(controls).toHaveProperty(c.labelKey)
    }
  })

  it("is a curated subset (documented, not exhaustive)", () => {
    // Guards against accidental emptiness without pretending to be complete.
    expect(SETTING_CONTROLS.length).toBeGreaterThanOrEqual(15)
  })
})
