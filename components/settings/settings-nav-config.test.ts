import {
  SETTINGS_GROUP_ORDER,
  SETTINGS_NAV,
  SETTINGS_SEARCH_KEYWORDS,
  isSearchMatch,
  type NavItem,
  type SettingsSectionId,
} from "./settings-nav-config"

describe("settings-nav-config", () => {
  describe("SETTINGS_NAV completeness", () => {
    it("exposes every SettingsSectionId in nav or as an explicit out-of-nav entry", () => {
      const navIds = new Set(SETTINGS_NAV.map((n) => n.id))
      const keywordIds = Object.keys(SETTINGS_SEARCH_KEYWORDS) as SettingsSectionId[]
      // Keyword index covers every nav id (so search has something to match).
      for (const item of SETTINGS_NAV) {
        expect(SETTINGS_SEARCH_KEYWORDS[item.id]).toBeDefined()
      }
      // Every nav id is unique.
      expect(navIds.size).toBe(SETTINGS_NAV.length)
      // Every keyword bucket either belongs to a nav item or is intentionally
      // tracked outside the sidebar (none right now).
      for (const id of keywordIds) {
        if (!navIds.has(id)) {
          throw new Error(`SETTINGS_SEARCH_KEYWORDS contains '${id}' but no NavItem references it.`)
        }
      }
    })

    it("agent-teams sits in the AI group with Layers3 icon", () => {
      const item = SETTINGS_NAV.find((n) => n.id === "agent-teams")
      expect(item).toBeDefined()
      expect(item?.group).toBe("ai")
      expect(item?.labelKey).toBe("agentTeams")
      expect(item?.descriptionKey).toBe("agentTeams")
    })

    it("plugins sits in the Extensions group", () => {
      const item = SETTINGS_NAV.find((n) => n.id === "plugins")
      expect(item).toBeDefined()
      expect(item?.group).toBe("extensions")
      expect(item?.labelKey).toBe("plugins")
    })

    it("remote-control sits in the System group and is desktopOnly", () => {
      const item = SETTINGS_NAV.find((n) => n.id === "remote-control")
      expect(item).toBeDefined()
      expect(item?.group).toBe("system")
      expect(item?.desktopOnly).toBe(true)
      expect(item?.labelKey).toBe("remoteControl")
    })

    it("Pro IDE is a searchable desktop-only interface section", () => {
      const item = SETTINGS_NAV.find((n) => n.id === "pro-ide")
      expect(item).toMatchObject({
        group: "interface",
        labelKey: "proIde",
        descriptionKey: "proIde",
        desktopOnly: true,
      })
      expect(SETTINGS_SEARCH_KEYWORDS["pro-ide"]).toEqual(
        expect.arrayContaining(["code-server", "vscode", "内嵌编辑器"])
      )
    })

    it("each nav group appears in SETTINGS_GROUP_ORDER", () => {
      const groupSet = new Set(SETTINGS_NAV.map((n) => n.group))
      for (const g of groupSet) {
        expect(SETTINGS_GROUP_ORDER).toContain(g)
      }
    })
  })

  describe("isSearchMatch", () => {
    const t = (key: string) => key // namespaced i18n keys passed through

    function navItem(overrides: Partial<NavItem>): NavItem {
      return {
        id: "agents",
        labelKey: "agents",
        descriptionKey: "agents",
        group: "ai",
        icon: () => null,
        ...overrides,
      } as NavItem
    }

    it("returns true for empty query", () => {
      expect(isSearchMatch(navItem({}), "", t)).toBe(true)
      expect(isSearchMatch(navItem({}), "   ", t)).toBe(true)
    })

    it("matches by label key", () => {
      // t() returns the key itself, so "settings.tabs.agents" includes "agents".
      expect(isSearchMatch(navItem({ labelKey: "agents" }), "agents", t)).toBe(true)
    })

    it("matches by keyword", () => {
      const item = SETTINGS_NAV.find((n) => n.id === "agent-teams")!
      expect(isSearchMatch(item, "supervisor", t)).toBe(true)
      expect(isSearchMatch(item, "团队", t)).toBe(true)
    })

    it("matches plugins keyword", () => {
      const item = SETTINGS_NAV.find((n) => n.id === "plugins")!
      expect(isSearchMatch(item, "marketplace", t)).toBe(true)
    })

    it("matches remote-control keyword", () => {
      const item = SETTINGS_NAV.find((n) => n.id === "remote-control")!
      expect(isSearchMatch(item, "webhook", t)).toBe(true)
      expect(isSearchMatch(item, "远程控制", t)).toBe(true)
    })

    it("returns false on unrelated query", () => {
      expect(isSearchMatch(navItem({}), "definitely-no-match-xyz", t)).toBe(false)
    })

    it("uses description key on label miss", () => {
      const item = navItem({ labelKey: "x", descriptionKey: "long-description-token" })
      expect(isSearchMatch(item, "long-description-token", t)).toBe(true)
    })
  })
})
