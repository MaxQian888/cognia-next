import {
  getMobileQuickActionCatalog,
  resolveMobileHomeLayout,
  MOBILE_QUICK_ACTION_ICONS,
} from "./mobile-home-nav"
import { MOBILE_QUICK_ACTION_CATALOG, DEFAULT_MOBILE_HOME_LAYOUT } from "@/types/shell/mobile-home"

describe("mobile-home-nav", () => {
  it("attaches an icon to every catalog id", () => {
    const catalog = getMobileQuickActionCatalog()
    expect(catalog).toHaveLength(MOBILE_QUICK_ACTION_CATALOG.length)
    for (const item of catalog) {
      expect(MOBILE_QUICK_ACTION_ICONS[item.id]).toBeDefined()
      expect(item.Icon).toBe(MOBILE_QUICK_ACTION_ICONS[item.id])
    }
  })

  it("resolves active in stored order and available as the remainder", () => {
    const catalog = getMobileQuickActionCatalog()
    const { active, available } = resolveMobileHomeLayout(catalog, {
      quickActions: ["discover", "newChat"],
      hiddenSections: [],
    })
    expect(active.map((i) => i.id)).toEqual(["discover", "newChat"])
    // Everything else stays in catalog order.
    expect(available.map((i) => i.id)).toEqual(
      catalog.map((i) => i.id).filter((id) => id !== "discover" && id !== "newChat")
    )
  })

  it("dedupes and drops unknown ids", () => {
    const catalog = getMobileQuickActionCatalog()
    const { active } = resolveMobileHomeLayout(catalog, {
      quickActions: ["newChat", "newChat", "does-not-exist", "search"],
      hiddenSections: [],
    })
    expect(active.map((i) => i.id)).toEqual(["newChat", "search"])
  })

  it("default layout resolves to four active actions", () => {
    const catalog = getMobileQuickActionCatalog()
    const { active } = resolveMobileHomeLayout(catalog, DEFAULT_MOBILE_HOME_LAYOUT)
    expect(active.map((i) => i.id)).toEqual(DEFAULT_MOBILE_HOME_LAYOUT.quickActions)
  })
})
