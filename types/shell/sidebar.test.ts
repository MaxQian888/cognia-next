import { SIDEBAR_NAV_META, DEFAULT_SIDEBAR_LAYOUT } from "./sidebar"

describe("sidebar nav meta", () => {
  it("has unique ids", () => {
    const ids = SIDEBAR_NAV_META.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("has unique routes", () => {
    const routes = SIDEBAR_NAV_META.map((m) => m.route)
    expect(new Set(routes).size).toBe(routes.length)
  })

  it("uses each id as a route segment", () => {
    for (const m of SIDEBAR_NAV_META) {
      expect(m.route.startsWith("/")).toBe(true)
    }
  })

  it("only feature/auxiliary groups", () => {
    for (const m of SIDEBAR_NAV_META) {
      expect(["feature", "auxiliary"]).toContain(m.group)
    }
  })

  it("pins the three work-arrives-here entries, in rail order", () => {
    expect(DEFAULT_SIDEBAR_LAYOUT.pinned).toEqual(["inbox", "workflows", "agent-teams"])
  })

  it("leaves the remaining features to the More popover", () => {
    // Pinning every `feature` (the old default) put 11 icons on a 64px rail.
    // These configure-once destinations are one More click away instead.
    const featureIds = SIDEBAR_NAV_META.filter((m) => m.group === "feature").map((m) => m.id)
    const unpinnedFeatures = featureIds.filter((id) => !DEFAULT_SIDEBAR_LAYOUT.pinned.includes(id))
    expect(unpinnedFeatures.sort()).toEqual([
      "browser",
      "discover",
      "goals",
      "pet",
      "plugins",
      "scheduler",
      "skills",
      "twin",
    ])
    // Unpinned is not hidden — `resolveSidebarLayout` derives overflow from
    // catalog − pinned − hidden, so every one of them is still reachable.
    expect(DEFAULT_SIDEBAR_LAYOUT.hidden).toEqual([])
  })

  it("default hides nothing", () => {
    expect(DEFAULT_SIDEBAR_LAYOUT.hidden).toEqual([])
  })

  it("every default-pinned id exists in the catalog", () => {
    const ids = new Set(SIDEBAR_NAV_META.map((m) => m.id))
    for (const id of DEFAULT_SIDEBAR_LAYOUT.pinned) {
      expect(ids.has(id)).toBe(true)
    }
  })

  it("marks only the known desktop-only items", () => {
    const desktopOnly = SIDEBAR_NAV_META.filter((m) => m.desktopOnly).map((m) => m.id)
    // `browser` is a feature-group entry rather than an auxiliary one, but the
    // embedded webview only exists in the Tauri shell, so it is desktop-only too.
    expect(desktopOnly.sort()).toEqual(["browser", "performance", "source-control"])
  })
})
