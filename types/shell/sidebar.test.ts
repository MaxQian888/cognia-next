import { SIDEBAR_NAV_META, DEFAULT_SIDEBAR_LAYOUT, DEFAULT_SIDEBAR_SIDE } from "./sidebar"
import enMessages from "@/i18n/messages/en.json"
import zhCnMessages from "@/i18n/messages/zh-CN.json"

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

  it.each([
    ["en", enMessages],
    ["zh-CN", zhCnMessages],
  ])("defines every dynamic rail label in %s", (_locale, messages) => {
    const labels = messages.desktop.guildRail as Record<string, unknown>
    for (const item of SIDEBAR_NAV_META) {
      expect(labels[item.i18nKey]).toEqual(expect.any(String))
    }
  })

  it("pins the four work-arrives-here entries, in rail order", () => {
    // `issues` joined the shipped pins when the tracker landed: it is the
    // surface work is *filed* into, which is the same criterion the other
    // three meet (an inbox that fills up, workflows you re-run, teams you hand
    // tasks to). Its two management siblings — /projects and /workspace — are
    // configure-occasionally and stay in "More".
    expect(DEFAULT_SIDEBAR_LAYOUT.pinned).toEqual(["issues", "inbox", "workflows", "squads"])
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
      "templates",
      "twin",
    ])
    // Unpinned is not hidden — `resolveSidebarLayout` derives overflow from
    // catalog − pinned − hidden, so every one of them is still reachable.
    expect(DEFAULT_SIDEBAR_LAYOUT.hidden).toEqual([])
  })

  it("default hides nothing", () => {
    expect(DEFAULT_SIDEBAR_LAYOUT.hidden).toEqual([])
  })

  it("ships the rail on the left edge", () => {
    // The right edge shipped as the default briefly and read as disorienting —
    // this is the Discord/Slack arrangement every muscle memory was built on.
    // Still a preference (`sidebarSide`), just not where the rail lands by
    // default.
    expect(DEFAULT_SIDEBAR_SIDE).toBe("left")
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
    expect(desktopOnly.sort()).toEqual(["browser", "performance"])
  })
})
