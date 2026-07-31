import {
  getWorkbenchRailCatalog,
  isDefaultWorkbenchRailLayout,
  isWorkbenchActivityHidden,
  resolveWorkbenchRailLayout,
  workbenchRailIndex,
  WORKBENCH_ACTIVITY_ICONS,
} from "./workbench-rail"
import {
  CANONICAL_CONTEXT_ACTIVITIES,
  CONTEXT_ACTIVITY_RAIL_ORDER,
} from "@/types/context-workbench"
import { DEFAULT_WORKBENCH_RAIL_LAYOUT } from "@/types/shell/workbench-rail"

describe("workbench rail catalog", () => {
  it("covers exactly the canonical activities", () => {
    // The two lists are maintained separately (one alphabetical, one in rail
    // order). A member in one and not the other would either strand an activity
    // off the customizer or put a dead id in the stored layout.
    const catalogIds = getWorkbenchRailCatalog().map((i) => i.id)
    expect([...catalogIds].sort()).toEqual([...CANONICAL_CONTEXT_ACTIVITIES].sort())
  })

  it("is ordered like the rail, not alphabetically", () => {
    // Catalog order is what `resolveOrderedLayout` falls back to for ids a
    // stored layout never mentioned, so it has to be the rail's order.
    expect(getWorkbenchRailCatalog().map((i) => i.id)).toEqual([...CONTEXT_ACTIVITY_RAIL_ORDER])
  })

  it("maps every activity to a real icon", () => {
    for (const id of CANONICAL_CONTEXT_ACTIVITIES) {
      expect(WORKBENCH_ACTIVITY_ICONS[id]).toBeDefined()
    }
  })
})

describe("resolveWorkbenchRailLayout", () => {
  const catalog = getWorkbenchRailCatalog()

  it("honours a user order", () => {
    const resolved = resolveWorkbenchRailLayout(catalog, {
      order: ["workspace", "ai"],
      hidden: [],
    })
    // The two named ids lead; the rest follow in catalog order.
    expect(resolved.visible.slice(0, 2).map((i) => i.id)).toEqual(["workspace", "ai"])
    expect(resolved.visible).toHaveLength(catalog.length)
  })

  it("keeps a hidden activity's slot so unhiding restores it in place", () => {
    const resolved = resolveWorkbenchRailLayout(catalog, {
      order: [...CONTEXT_ACTIVITY_RAIL_ORDER],
      hidden: ["review"],
    })
    expect(resolved.hidden.map((i) => i.id)).toEqual(["review"])
    expect(resolved.visible.map((i) => i.id)).not.toContain("review")
    // Still second in the full order — where it was before it was hidden.
    expect(resolved.order.map((i) => i.id)[1]).toBe("review")
  })
})

describe("workbenchRailIndex", () => {
  it("sorts by the stored order", () => {
    const layout = { order: ["workspace", "preview-run", "ai"], hidden: [] }
    expect(workbenchRailIndex("workspace", layout)).toBeLessThan(
      workbenchRailIndex("preview-run", layout)
    )
  })

  it("sorts an unknown (plugin) activity after every named one", () => {
    const layout = DEFAULT_WORKBENCH_RAIL_LAYOUT
    // The guarantee a third-party panel relies on: it can never fall off the
    // rail just because the user reordered the built-ins.
    expect(workbenchRailIndex("acme:custom", layout)).toBe(layout.order.length)
    for (const id of layout.order) {
      expect(workbenchRailIndex(id, layout)).toBeLessThan(layout.order.length)
    }
  })
})

describe("isWorkbenchActivityHidden", () => {
  it("reports only the hidden set", () => {
    const layout = { order: [...CONTEXT_ACTIVITY_RAIL_ORDER], hidden: ["comments"] }
    expect(isWorkbenchActivityHidden("comments", layout)).toBe(true)
    expect(isWorkbenchActivityHidden("ai", layout)).toBe(false)
  })
})

describe("isDefaultWorkbenchRailLayout", () => {
  it("recognises the shipped layout", () => {
    expect(isDefaultWorkbenchRailLayout(DEFAULT_WORKBENCH_RAIL_LAYOUT)).toBe(true)
  })

  it("rejects a reorder or a hide", () => {
    expect(
      isDefaultWorkbenchRailLayout({
        order: [...DEFAULT_WORKBENCH_RAIL_LAYOUT.order].reverse(),
        hidden: [],
      })
    ).toBe(false)
    expect(
      isDefaultWorkbenchRailLayout({
        order: [...DEFAULT_WORKBENCH_RAIL_LAYOUT.order],
        hidden: ["ai"],
      })
    ).toBe(false)
  })
})
