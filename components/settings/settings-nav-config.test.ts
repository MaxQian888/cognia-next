import { CORE_CAPABILITY_IDS, type CapabilityId } from "@/lib/platform/capabilities"
import {
  SETTINGS_GROUP_ORDER,
  SETTINGS_NAV,
  SETTINGS_SEARCH_KEYWORDS,
  isSearchMatch,
  isSettingsSectionReachable,
  reachableSettingsSections,
  type NavItem,
  type SettingsReachabilityContext,
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

    it("squads sits in the AI group with Layers3 icon", () => {
      const item = SETTINGS_NAV.find((n) => n.id === "squads")
      expect(item).toBeDefined()
      expect(item?.group).toBe("ai")
      expect(item?.labelKey).toBe("squads")
      expect(item?.descriptionKey).toBe("squads")
    })

    it("splits AI Connections and Model Catalog without reusing generic Connections", () => {
      expect(SETTINGS_NAV.find((item) => item.id === "ai-connections")).toMatchObject({
        group: "ai",
        labelKey: "aiConnections",
      })
      expect(SETTINGS_NAV.find((item) => item.id === "model-catalog")).toMatchObject({
        group: "ai",
        labelKey: "modelCatalog",
      })
      expect(SETTINGS_NAV.find((item) => item.id === "connections")).toBeDefined()
      expect(SETTINGS_NAV.find((item) => item.id === "providers")).toBeUndefined()
    })

    it("plugins sits in the Extensions group", () => {
      const item = SETTINGS_NAV.find((n) => n.id === "plugins")
      expect(item).toBeDefined()
      expect(item?.group).toBe("extensions")
      expect(item?.labelKey).toBe("plugins")
    })

    it("webhooks sits in the System group and requires an always-on host", () => {
      const item = SETTINGS_NAV.find((n) => n.id === "webhooks")
      expect(item).toBeDefined()
      expect(item?.group).toBe("system")
      expect(item?.requires).toEqual(["always-on"])
      expect(item?.labelKey).toBe("webhooks")
    })

    it("Pro IDE is a searchable interface section that requires a shell host", () => {
      const item = SETTINGS_NAV.find((n) => n.id === "pro-ide")
      expect(item).toMatchObject({
        group: "interface",
        labelKey: "proIde",
        descriptionKey: "proIde",
        requires: ["shell"],
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
      const item = SETTINGS_NAV.find((n) => n.id === "squads")!
      expect(isSearchMatch(item, "supervisor", t)).toBe(true)
      expect(isSearchMatch(item, "团队", t)).toBe(true)
    })

    it("matches plugins keyword", () => {
      const item = SETTINGS_NAV.find((n) => n.id === "plugins")!
      expect(isSearchMatch(item, "marketplace", t)).toBe(true)
    })

    it("finds the SSH host editor under the terminal section", () => {
      const item = SETTINGS_NAV.find((n) => n.id === "terminal")!
      expect(isSearchMatch(item, "ssh", t)).toBe(true)
    })

    it("matches webhook keywords without advertising the deleted inbound listener", () => {
      const item = SETTINGS_NAV.find((n) => n.id === "webhooks")!
      expect(isSearchMatch(item, "webhook", t)).toBe(true)
      expect(isSearchMatch(item, "签名", t)).toBe(true)
      expect(isSearchMatch(item, "inbound", t)).toBe(false)
    })

    it("returns false on unrelated query", () => {
      expect(isSearchMatch(navItem({}), "definitely-no-match-xyz", t)).toBe(false)
    })

    it("uses description key on label miss", () => {
      const item = navItem({ labelKey: "x", descriptionKey: "long-description-token" })
      expect(isSearchMatch(item, "long-description-token", t)).toBe(true)
    })
  })

  describe("section reachability (ADR-0059 D7 / F5)", () => {
    const withCaps = (
      profile: SettingsReachabilityContext["profile"],
      caps: readonly CapabilityId[]
    ): SettingsReachabilityContext => ({
      profile,
      hasCapability: (cap) => caps.includes(cap),
    })
    const DESKTOP_CAPS: readonly CapabilityId[] = [
      "webview",
      "shell",
      "pty",
      "sidecar",
      "keyring",
      "uia-automation",
      "ocr",
      "always-on",
      "connector-runtime",
      "mcp-runtime",
      "push-display",
      "browser",
    ]
    // What a companion client reaches: its own webview plus the server-backed set.
    const COMPANION_CAPS: readonly CapabilityId[] = [
      "webview",
      "shell",
      "pty",
      "sidecar",
      "keyring",
      "always-on",
      "connector-runtime",
      "mcp-runtime",
      "headless",
    ]
    const desktop = withCaps("desktop", DESKTOP_CAPS)
    const cloudCompanion = withCaps("cloud-companion", COMPANION_CAPS)
    const webStandalone = withCaps("web-standalone", ["webview"])

    it("no nav item still keys itself on the host with a `desktopOnly` flag", () => {
      for (const item of SETTINGS_NAV) {
        expect(item).not.toHaveProperty("desktopOnly")
      }
    })

    it("every declared requirement is a core capability id and every profile pin is meaningful", () => {
      const core = new Set<string>(CORE_CAPABILITY_IDS)
      for (const item of SETTINGS_NAV) {
        for (const cap of item.requires ?? []) expect(core.has(cap)).toBe(true)
        if (item.profiles) expect(item.profiles.length).toBeGreaterThan(0)
      }
    })

    it("a section with no requirements is reachable everywhere", () => {
      expect(isSettingsSectionReachable({}, webStandalone)).toBe(true)
      expect(isSettingsSectionReachable({}, cloudCompanion)).toBe(true)
      expect(isSettingsSectionReachable({}, desktop)).toBe(true)
    })

    it("requires ALL listed capabilities and honours the profile pin", () => {
      expect(isSettingsSectionReachable({ requires: ["shell", "ocr"] }, cloudCompanion)).toBe(false)
      expect(isSettingsSectionReachable({ requires: ["shell", "ocr"] }, desktop)).toBe(true)
      expect(
        isSettingsSectionReachable({ requires: ["shell"], profiles: ["desktop"] }, cloudCompanion)
      ).toBe(false)
      expect(isSettingsSectionReachable({ profiles: ["desktop"] }, desktop)).toBe(true)
    })

    it("the desktop reaches every section", () => {
      expect(reachableSettingsSections(desktop).size).toBe(SETTINGS_NAV.length)
    })

    it("a cloud companion reaches the sections its brain executes, not local-shell surfaces", () => {
      const reachable = reachableSettingsSections(cloudCompanion)
      // Backend runs on the paired brain — follows the capability, not the host.
      for (const id of [
        "subscription",
        "connections",
        "terminal",
        "source-control",
        "sandbox",
        "lsp",
        "tools",
        "webhooks",
        "gateway",
        "pro-ide",
        "workspace-trust",
        "discover",
        "security",
        // The remote-host registry is client-side: the store, the credential
        // vault and `CompanionTransport` all work here. It was pinned to the
        // desktop, which made `/devices`' own "Add host" action land on a
        // settings empty state on every other shell.
        "remote-hosts",
      ] as const) {
        expect(reachable.has(id)).toBe(true)
      }
      // Recorded physical boundaries and local-shell surfaces stay desktop-only.
      for (const id of ["automation", "desktop", "companion", "sidebar"] as const) {
        expect(reachable.has(id)).toBe(false)
      }
      // Transitional pins: renderer path still bypasses the transport seam.
      for (const id of ["ccswitch", "hooks", "fleet"] as const) {
        expect(reachable.has(id)).toBe(false)
      }
    })

    it("a web-standalone client reaches only what runs in the webview", () => {
      const reachable = reachableSettingsSections(webStandalone)
      for (const id of ["terminal", "source-control", "subscription", "desktop"] as const) {
        expect(reachable.has(id)).toBe(false)
      }
      for (const id of [
        "ai-connections",
        "appearance",
        "discover",
        "security",
        // A browser with nothing paired has exactly one way to stop being
        // standalone, and this is it.
        "remote-hosts",
      ] as const) {
        expect(reachable.has(id)).toBe(true)
      }
    })
  })
})
