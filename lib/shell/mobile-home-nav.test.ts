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

  /**
   * `/templates` had a full phone body and no way in: no quick action, no `/me`
   * row, no tab-bar prefix. A catalog reachable only by typing the URL is a
   * feature that shipped switched off.
   */
  it("offers the template catalog as a quick action", () => {
    const templates = getMobileQuickActionCatalog().find((item) => item.id === "templates")
    expect(templates).toMatchObject({ kind: "route", route: "/templates", i18nKey: "templates" })
    expect(templates?.Icon).toBeDefined()
    expect(templates?.spotIcon).toBe("skills")
  })

  it("default layout resolves to four active actions", () => {
    const catalog = getMobileQuickActionCatalog()
    const { active } = resolveMobileHomeLayout(catalog, DEFAULT_MOBILE_HOME_LAYOUT)
    expect(active.map((i) => i.id)).toEqual(DEFAULT_MOBILE_HOME_LAYOUT.quickActions)
  })
})

/**
 * ADR-0140 retired `/agent-teams` and took it out of navigation, but the mobile
 * quick action still pointed at it, so the tile was a shortcut to a route
 * nothing else links to. The id doubles as the persistence key, so it has to be
 * mapped on read rather than dropped: dropping it deletes the tile from every
 * saved grid instead of moving it.
 */
describe("the retired agent-teams tile", () => {
  it("resolves a saved agentTeams tile to the squads one", () => {
    const { active } = resolveMobileHomeLayout(getMobileQuickActionCatalog(), {
      quickActions: ["agentTeams"],
      hiddenSections: [...DEFAULT_MOBILE_HOME_LAYOUT.hiddenSections],
    })
    expect(active.map((item) => item.id)).toEqual(["squads"])
    expect(active[0]!.route).toBe("/squads")
  })

  it("does not offer the tile twice when both ids are stored", () => {
    const { active, available } = resolveMobileHomeLayout(getMobileQuickActionCatalog(), {
      quickActions: ["agentTeams", "squads"],
      hiddenSections: [...DEFAULT_MOBILE_HOME_LAYOUT.hiddenSections],
    })
    expect(active.filter((item) => item.id === "squads")).toHaveLength(1)
    expect(available.some((item) => item.id === "squads")).toBe(false)
  })
})
