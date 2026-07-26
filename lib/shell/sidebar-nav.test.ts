import { SIDEBAR_NAV_META, DEFAULT_SIDEBAR_LAYOUT, DEFAULT_PINNED_IDS } from "@/types/shell/sidebar"
import {
  SIDEBAR_NAV_ICONS,
  applyDragReorder,
  getSidebarCatalog,
  resolveSidebarLayout,
  type SidebarCatalogItem,
} from "./sidebar-nav"

describe("SIDEBAR_NAV_ICONS", () => {
  it("maps every catalog id to an icon", () => {
    for (const m of SIDEBAR_NAV_META) {
      expect(SIDEBAR_NAV_ICONS[m.id]).toBeTruthy()
    }
  })
})

describe("getSidebarCatalog", () => {
  it("returns the full catalog with icons on desktop", () => {
    const cat = getSidebarCatalog("tauri")
    expect(cat).toHaveLength(SIDEBAR_NAV_META.length)
    expect(cat.every((c) => typeof c.Icon === "function" || typeof c.Icon === "object")).toBe(true)
  })

  it("drops desktop-only items on mobile", () => {
    const cat = getSidebarCatalog("mobile")
    const ids = cat.map((c) => c.id)
    expect(ids).not.toContain("performance")
    expect(ids).not.toContain("source-control")
    expect(ids).toContain("workflows")
    // Derived, not hard-coded — the browser pane addition broke a literal "-2".
    expect(cat).toHaveLength(SIDEBAR_NAV_META.filter((m) => !m.desktopOnly).length)
  })

  it("drops desktop-only items on web too (ADR-0059 F5 — no dead ends in a browser)", () => {
    const cat = getSidebarCatalog("web")
    const ids = cat.map((c) => c.id)
    expect(ids).not.toContain("performance")
    expect(ids).not.toContain("source-control")
    expect(ids).not.toContain("browser")
    expect(ids).toContain("workflows")
  })
})

describe("resolveSidebarLayout", () => {
  const catalog = getSidebarCatalog("tauri")
  const ids = (items: SidebarCatalogItem[]) => items.map((i) => i.id)

  // The de-crowded rail pins three ids and pushes everything else into "More",
  // rather than pinning the whole `feature` group as it used to.
  it("applies the default layout: three ids pinned, the rest in overflow", () => {
    const { pinned, overflow, hidden } = resolveSidebarLayout(catalog, DEFAULT_SIDEBAR_LAYOUT)
    expect(ids(pinned)).toEqual([...DEFAULT_PINNED_IDS])
    expect(ids(overflow)).toEqual(
      SIDEBAR_NAV_META.filter((m) => !DEFAULT_PINNED_IDS.includes(m.id as never)).map((m) => m.id)
    )
    expect(hidden).toEqual([])
  })

  it("preserves the stored pinned order (not catalog order)", () => {
    const { pinned } = resolveSidebarLayout(catalog, { pinned: ["goals", "inbox"], hidden: [] })
    expect(ids(pinned)).toEqual(["goals", "inbox"])
  })

  it("drops unknown ids from pinned and hidden", () => {
    const { pinned, hidden } = resolveSidebarLayout(catalog, {
      pinned: ["workflows", "does-not-exist"],
      hidden: ["nope"],
    })
    expect(ids(pinned)).toEqual(["workflows"])
    expect(hidden).toEqual([])
  })

  it("dedupes repeated pinned ids", () => {
    const { pinned } = resolveSidebarLayout(catalog, {
      pinned: ["inbox", "inbox", "twin"],
      hidden: [],
    })
    expect(ids(pinned)).toEqual(["inbox", "twin"])
  })

  it("lets pinned win over hidden for the same id", () => {
    const { pinned, hidden, overflow } = resolveSidebarLayout(catalog, {
      pinned: ["logs"],
      hidden: ["logs"],
    })
    expect(ids(pinned)).toContain("logs")
    expect(ids(hidden)).not.toContain("logs")
    expect(ids(overflow)).not.toContain("logs")
  })

  it("routes hidden ids to hidden and the rest to overflow", () => {
    const { overflow, hidden } = resolveSidebarLayout(catalog, {
      pinned: [],
      hidden: ["me"],
    })
    expect(ids(hidden)).toEqual(["me"])
    // Everything not pinned and not hidden falls to overflow.
    expect(ids(overflow)).toContain("workflows")
    expect(ids(overflow)).not.toContain("me")
  })

  it("places catalog items absent from the layout into overflow (forward-compat)", () => {
    // Simulate a stored layout from before a new item ('twin') was added.
    const { overflow } = resolveSidebarLayout(catalog, {
      pinned: ["workflows"],
      hidden: [],
    })
    expect(ids(overflow)).toContain("twin")
  })

  it("keeps overflow in catalog order", () => {
    const { overflow } = resolveSidebarLayout(catalog, { pinned: [], hidden: [] })
    const catalogOrder = catalog.map((c) => c.id)
    const overflowOrder = ids(overflow)
    // overflow is a subsequence of catalog order
    let j = 0
    for (const id of catalogOrder) {
      if (overflowOrder[j] === id) j++
    }
    expect(j).toBe(overflowOrder.length)
  })
})

describe("applyDragReorder", () => {
  it("moves the active id to the over id position", () => {
    expect(applyDragReorder(["a", "b", "c"], "a", "c")).toEqual(["b", "c", "a"])
    expect(applyDragReorder(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"])
  })

  it("returns null when dropped on nothing", () => {
    expect(applyDragReorder(["a", "b"], "a", null)).toBeNull()
  })

  it("returns null when dropped on itself", () => {
    expect(applyDragReorder(["a", "b"], "a", "a")).toBeNull()
  })

  it("returns null when an id is not in the list", () => {
    expect(applyDragReorder(["a", "b"], "ghost", "a")).toBeNull()
    expect(applyDragReorder(["a", "b"], "a", "ghost")).toBeNull()
  })
})
