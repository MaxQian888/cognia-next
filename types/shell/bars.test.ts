import {
  BAR_ZONE_ORDER,
  DEFAULT_STATUS_BAR_LAYOUT,
  DEFAULT_TITLE_BAR_LAYOUT,
  STATUS_BAR_ITEMS,
  TITLE_BAR_ITEMS,
  barCatalogMeta,
  defaultBarLayout,
} from "./bars"

const ALL = [...TITLE_BAR_ITEMS, ...STATUS_BAR_ITEMS]

describe("bar item catalogs", () => {
  it("has ids unique across both bars", () => {
    // The two bars persist separate layouts, but a shared id space keeps the
    // icon map, the i18n namespace and every `data-testid` unambiguous.
    const ids = ALL.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("tags every item with its own bar", () => {
    for (const m of TITLE_BAR_ITEMS) expect(m.bar).toBe("title")
    for (const m of STATUS_BAR_ITEMS) expect(m.bar).toBe("status")
  })

  it("only uses known zones", () => {
    for (const m of ALL) expect(BAR_ZONE_ORDER).toContain(m.zone)
  })

  it("uses each id as its own i18n key", () => {
    for (const m of ALL) expect(m.i18nKey).toBe(m.id)
  })

  it("routes barCatalogMeta to the matching catalog", () => {
    expect(barCatalogMeta("title")).toBe(TITLE_BAR_ITEMS)
    expect(barCatalogMeta("status")).toBe(STATUS_BAR_ITEMS)
  })

  it("keeps the title bar's centre free of end-zone-only controls", () => {
    // The window buttons and drag regions are not in the catalog at all, so
    // the end zone is exactly the optional actions followed by the four
    // independently-customizable VS Code-style layout controls.
    expect(TITLE_BAR_ITEMS.filter((m) => m.zone === "end").map((m) => m.id)).toEqual([
      "quickActions",
      "accountTop",
      "primarySidebarToggle",
      "panelToggle",
      "secondarySidebarToggle",
      "layoutControls",
    ])
  })

  it("marks only the natively-backed status segments desktop-only", () => {
    const desktopOnly = STATUS_BAR_ITEMS.filter((m) => m.desktopOnly).map((m) => m.id)
    expect(desktopOnly.sort()).toEqual(["perf", "sync", "terminal", "usage"])
  })

  it("has no desktop-only title-bar items", () => {
    // The whole title bar only mounts under Tauri, so per-item gating would be
    // dead weight there.
    expect(TITLE_BAR_ITEMS.filter((m) => m.desktopOnly)).toEqual([])
  })

  it("only assigns breakpoints to items that had one before", () => {
    const withMinWidth = ALL.filter((m) => m.minWidth).map((m) => [m.id, m.minWidth])
    expect(withMinWidth).toEqual([
      ["workspace", "lg"],
      ["commandCenter", "lg"],
      ["quickActions", "xl"],
    ])
  })
})

describe("default bar layouts", () => {
  it("orders the title bar as the catalog does", () => {
    expect(DEFAULT_TITLE_BAR_LAYOUT.order).toEqual(TITLE_BAR_ITEMS.map((m) => m.id))
  })

  it("orders the status bar as the catalog does", () => {
    expect(DEFAULT_STATUS_BAR_LAYOUT.order).toEqual(STATUS_BAR_ITEMS.map((m) => m.id))
  })

  it("ships the account button in the status bar only", () => {
    expect(DEFAULT_TITLE_BAR_LAYOUT.hidden).toContain("accountTop")
    expect(DEFAULT_STATUS_BAR_LAYOUT.hidden).not.toContain("accountStatus")
  })

  it("ships quick actions hidden and the perf monitor opt-in", () => {
    expect([...DEFAULT_TITLE_BAR_LAYOUT.hidden].sort()).toEqual(["accountTop", "quickActions"])
    // `terminal` is opt-in too: the dock already has three entry points, so a
    // fourth permanent bottom-bar control would spend chrome budget for nothing.
    expect([...DEFAULT_STATUS_BAR_LAYOUT.hidden].sort()).toEqual(["perf", "terminal"])
  })

  it("only hides ids that exist in the catalog", () => {
    const titleIds = new Set(TITLE_BAR_ITEMS.map((m) => m.id))
    for (const id of DEFAULT_TITLE_BAR_LAYOUT.hidden) expect(titleIds.has(id)).toBe(true)
    const statusIds = new Set(STATUS_BAR_ITEMS.map((m) => m.id))
    for (const id of DEFAULT_STATUS_BAR_LAYOUT.hidden) expect(statusIds.has(id)).toBe(true)
  })

  it("returns a fresh object per call so callers cannot mutate the shipped default", () => {
    const a = defaultBarLayout("title")
    a.order.push("bogus")
    expect(defaultBarLayout("title").order).not.toContain("bogus")
  })
})
