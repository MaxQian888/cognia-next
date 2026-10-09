import { TEST_SHELL_NAV, makeProviderInput, makeTestContext } from "../testing"
import { actionCandidates, actionsProvider } from "./actions"

const hostDefaults: ReturnType<typeof makeTestContext>["host"] = {
  reachableSettingsSections: new Set(),
  recorderAvailable: false,
  petHostAvailable: false,
  petConsoleReachable: false,
  theme: "light",
  hasApiKey: false,
  pluginQuickActions: [],
  workbenchPanels: [],
  canBrowseHostFolders: true,
  shellNav: TEST_SHELL_NAV,
}

const host = (over: Partial<ReturnType<typeof makeTestContext>["host"]> = {}) =>
  makeTestContext({ host: { ...hostDefaults, ...over } })

describe("actions provider", () => {
  it("gates the recorder entry and flips the theme label", () => {
    const base = actionCandidates(host())
    expect(base.some((c) => c.id === "open-recorder")).toBe(false)
    expect(base.find((c) => c.id === "toggle-theme")!.title).toBe(
      "globalSearch.actions.switchToDark"
    )
    const dark = actionCandidates(host({ recorderAvailable: true, theme: "dark", hasApiKey: true }))
    expect(dark.some((c) => c.id === "open-recorder")).toBe(true)
    expect(dark.find((c) => c.id === "toggle-theme")!.title).toBe(
      "globalSearch.actions.switchToLight"
    )
    expect(dark.find((c) => c.id === "manage-api-key")!.extra?.current).toBe(true)
  })

  it("marks desktop-only commands as disabled off Tauri", () => {
    const web = actionCandidates(makeTestContext({ isTauri: false, host: hostDefaults }))
    expect(web.find((c) => c.id === "check-updates")!.extra?.disabledReason).toBeDefined()
  })

  /**
   * Folder browsing is NOT a desktop-only command. A paired phone or browser
   * walks the host's filesystem through the same picker the workspace switcher
   * opens, so gating this on `isTauri` made the palette refuse what the
   * switcher offered, on the same device.
   */
  it("offers the folder picker wherever a folder can actually be chosen", () => {
    const paired = actionCandidates(
      makeTestContext({ isTauri: false, host: { ...hostDefaults, canBrowseHostFolders: true } })
    )
    expect(paired.find((c) => c.id === "open-folder")!.extra).toBeUndefined()

    const unpaired = actionCandidates(
      makeTestContext({ isTauri: false, host: { ...hostDefaults, canBrowseHostFolders: false } })
    )
    expect(unpaired.find((c) => c.id === "open-folder")!.extra?.disabledReason).toBe(
      "globalSearch.actions.openFolderNeedsHost"
    )
  })

  /**
   * The switcher footer's other three entries. They lived inside a Popover in
   * the desktop rail and a Drawer on `/`, so on any other mobile route a
   * workspace could not be created, adopted or managed at all.
   */
  it("carries the workspace editors the switcher footer owns", () => {
    const ids = actionCandidates(makeTestContext()).map((c) => c.id)
    expect(ids).toEqual(
      expect.arrayContaining(["new-workspace", "adopt-workspaces", "manage-workspace-roots"])
    )
  })

  it("offers the pet actions only where the desktop pet can run (ADR-0058 D9)", () => {
    const off = actionCandidates(host())
    expect(off.some((c) => c.id === "toggle-desktop-pet")).toBe(false)
    expect(off.some((c) => c.id === "open-pet-console")).toBe(false)

    const on = actionCandidates(host({ petHostAvailable: true, petConsoleReachable: true }))
    expect(on.find((c) => c.id === "toggle-desktop-pet")).toMatchObject({
      title: "globalSearch.actions.toggleDesktopPet",
    })
    expect(on.find((c) => c.id === "open-pet-console")).toMatchObject({
      title: "globalSearch.actions.openPetConsole",
      subtitle: "globalSearch.actions.openPetConsoleHint",
    })
    // Hidden rather than disabled where they cannot run, so no greyed row.
    expect(on.find((c) => c.id === "toggle-desktop-pet")!.extra).toBeUndefined()
  })

  // ADR-0219: a paired phone or browser opens the console to care for the
  // desktop's pet, but summoning the pet onto a desktop stays the desktop's.
  it("opens the console on a client paired for remote pet care, without the desktop toggle", () => {
    const remote = actionCandidates(host({ petHostAvailable: false, petConsoleReachable: true }))
    expect(remote.some((c) => c.id === "open-pet-console")).toBe(true)
    expect(remote.some((c) => c.id === "toggle-desktop-pet")).toBe(false)
  })

  describe("navigation customization", () => {
    const nav = (over: Partial<typeof TEST_SHELL_NAV> = {}) =>
      host({ shellNav: { ...TEST_SHELL_NAV, ...over } })
    const ids = (ctx: ReturnType<typeof makeTestContext>) => actionCandidates(ctx).map((c) => c.id)
    const inbox = { id: "inbox", i18nKey: "inbox" }

    it("offers no page command off every catalog route", () => {
      const out = ids(nav())
      expect(out).not.toContain("pin-current-page")
      expect(out).not.toContain("unpin-current-page")
      expect(out).not.toContain("hide-current-page")
    })

    it("offers pin + hide for an unpinned page, titled with its rail label", () => {
      const rows = actionCandidates(nav({ currentPage: inbox }))
      expect(rows.find((c) => c.id === "pin-current-page")).toMatchObject({
        title: 'globalSearch.actions.pinPage:{"page":"desktop.guildRail.inbox"}',
        subtitle: undefined,
      })
      expect(rows.find((c) => c.id === "hide-current-page")).toMatchObject({
        title: 'globalSearch.actions.hidePage:{"page":"desktop.guildRail.inbox"}',
        subtitle: "globalSearch.actions.hidePageHint",
      })
      expect(rows.some((c) => c.id === "unpin-current-page")).toBe(false)
    })

    it("labels through the i18n key, not the id", () => {
      const rows = actionCandidates(
        nav({ currentPage: { id: "source-control", i18nKey: "sourceControl" } })
      )
      expect(rows.find((c) => c.id === "pin-current-page")!.title).toBe(
        'globalSearch.actions.pinPage:{"page":"desktop.guildRail.sourceControl"}'
      )
    })

    it("offers unpin + hide for a pinned page", () => {
      const out = ids(nav({ currentPage: inbox, currentPinned: true }))
      expect(out).toEqual(expect.arrayContaining(["unpin-current-page", "hide-current-page"]))
      expect(out).not.toContain("pin-current-page")
    })

    it("offers only pin for a hidden page, and says pinning shows it again", () => {
      const rows = actionCandidates(nav({ currentPage: inbox, currentHidden: true }))
      expect(rows.find((c) => c.id === "pin-current-page")!.subtitle).toBe(
        "globalSearch.actions.pinHiddenPageHint"
      )
      expect(rows.some((c) => c.id === "hide-current-page")).toBe(false)
      expect(rows.some((c) => c.id === "unpin-current-page")).toBe(false)
    })

    it("offers the page commands on mobile, where the drawer draws the pinned block", () => {
      const out = ids(
        makeTestContext({
          platform: "mobile",
          host: {
            ...hostDefaults,
            shellNav: { ...TEST_SHELL_NAV, currentPage: inbox, railChrome: false },
          },
        })
      )
      expect(out).toEqual(expect.arrayContaining(["pin-current-page", "hide-current-page"]))
      // No rail chrome to fold or move there.
      expect(out).not.toContain("hide-nav-rail")
      expect(out).not.toContain("show-nav-rail")
      expect(out).not.toContain("move-nav-rail-right")
      expect(out).not.toContain("move-nav-rail-left")
    })

    it("opens the customizer only where its settings section is reachable", () => {
      expect(ids(nav())).not.toContain("customize-navigation")
      const reachable = actionCandidates(host({ reachableSettingsSections: new Set(["sidebar"]) }))
      expect(reachable.find((c) => c.id === "customize-navigation")).toMatchObject({
        title: "globalSearch.actions.customizeNavigation",
      })
    })

    it("names the rail's outcome: show when folded, hide when showing", () => {
      expect(ids(nav())).toContain("hide-nav-rail")
      expect(ids(nav())).not.toContain("show-nav-rail")
      const folded = actionCandidates(nav({ railCollapsed: true }))
      expect(folded.find((c) => c.id === "show-nav-rail")!.title).toBe(
        "globalSearch.actions.showNavRail"
      )
      expect(folded.some((c) => c.id === "hide-nav-rail")).toBe(false)
    })

    it("names the edge the rail moves to", () => {
      const left = ids(nav({ side: "left" }))
      expect(left).toContain("move-nav-rail-right")
      expect(left).not.toContain("move-nav-rail-left")
      const right = actionCandidates(nav({ side: "right" }))
      expect(right.find((c) => c.id === "move-nav-rail-left")!.title).toBe(
        "globalSearch.actions.moveNavRailLeft"
      )
      expect(right.some((c) => c.id === "move-nav-rail-right")).toBe(false)
    })

    it("finds the navigation commands by Chinese and English terms", async () => {
      const ctx = nav({ currentPage: inbox })
      const zh = await actionsProvider.search(makeProviderInput("固定", { ctx }))
      expect(zh.items.map((i) => i.id)).toContain("action:pin-current-page")
      const en = await actionsProvider.search(makeProviderInput("rail", { ctx }))
      expect(en.items.map((i) => i.action)).toEqual(
        expect.arrayContaining([
          { type: "command", id: "hide-nav-rail" },
          { type: "command", id: "move-nav-rail-right" },
        ])
      )
    })
  })

  it("finds the pet actions by their Chinese and English names", async () => {
    const ctx = makeTestContext()
    const zh = await actionsProvider.search(makeProviderInput("桌宠", { ctx }))
    expect(zh.items[0]!.action).toEqual({ type: "command", id: "toggle-desktop-pet" })
    const en = await actionsProvider.search(makeProviderInput("nurture", { ctx }))
    expect(en.items.map((i) => i.id)).toContain("action:open-pet-console")
  })

  it("matches by keyword (bilingual) and produces command actions", async () => {
    const zh = await actionsProvider.search(makeProviderInput("主题"))
    expect(zh.items[0]!.action).toEqual({ type: "command", id: "toggle-theme" })
    const en = await actionsProvider.search(makeProviderInput("markdown"))
    expect(en.items[0]!.id).toBe("action:export-markdown")
    const none = await actionsProvider.search(makeProviderInput("qqqqq"))
    expect(none.items).toEqual([])
  })

  it("boosts primary commands on equal matches", async () => {
    // Every title is its i18n key: search the shared prefix so all match equally.
    const out = await actionsProvider.search(
      makeProviderInput("globalSearch.actions.", { limit: 50 })
    )
    const ids = out.items.map((i) => i.id)
    expect(ids.indexOf("action:new-chat")).toBeLessThan(ids.indexOf("action:toggle-sidebar"))
    expect(out.items[0]!.score).toBeLessThanOrEqual(1)
  })

  it("suggests only primary commands", async () => {
    const items = await actionsProvider.suggest!({
      ctx: host(),
      limit: 10,
      signal: new AbortController().signal,
    })
    expect(items.map((i) => i.id)).toEqual([
      "action:new-chat",
      "action:toggle-theme",
      "action:open-settings",
    ])
    expect(items[0]!.subtitle).toBe("globalSearch.actions.newChatHint")
  })
})
