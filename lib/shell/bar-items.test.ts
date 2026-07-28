import {
  BAR_ITEM_ICONS,
  getBarCatalog,
  isDefaultBarLayout,
  mergeVisibleOrder,
  migrateLegacyBarItems,
  resolveBarLayout,
} from "@/lib/shell/bar-items"
import {
  DEFAULT_STATUS_BAR_LAYOUT,
  DEFAULT_TITLE_BAR_LAYOUT,
  STATUS_BAR_ITEMS,
  TITLE_BAR_ITEMS,
} from "@/types/shell/bars"

const ids = (items: { id: string }[]) => items.map((i) => i.id)

describe("BAR_ITEM_ICONS", () => {
  it("covers every catalog id", () => {
    for (const m of [...TITLE_BAR_ITEMS, ...STATUS_BAR_ITEMS]) {
      expect(BAR_ITEM_ICONS[m.id]).toBeDefined()
    }
  })
})

describe("getBarCatalog", () => {
  it("returns the whole status catalog on the desktop shell", () => {
    expect(ids(getBarCatalog("status", "tauri"))).toEqual(ids([...STATUS_BAR_ITEMS]))
  })

  it("drops the natively-backed segments off the desktop shell", () => {
    const web = ids(getBarCatalog("status", "web"))
    expect(web).not.toContain("sync")
    expect(web).not.toContain("perf")
    expect(web).not.toContain("usage")
    expect(web).toContain("connectivity")
  })

  it("attaches an icon to every entry", () => {
    for (const item of getBarCatalog("title", "tauri")) {
      expect(item.Icon).toBe(BAR_ITEM_ICONS[item.id])
    }
  })
})

describe("resolveBarLayout", () => {
  const catalog = getBarCatalog("status", "tauri")

  it("buckets the shipped default into zones, perf hidden", () => {
    const resolved = resolveBarLayout(catalog, DEFAULT_STATUS_BAR_LAYOUT)
    expect(ids(resolved.zones.start)).toEqual(["connectivity", "branch", "sync"])
    expect(ids(resolved.zones.end)).toEqual([
      "notifications",
      "attention",
      "jobs",
      "usage",
      "accountStatus",
      "runStatus",
    ])
    expect(ids(resolved.zones.center)).toEqual([])
    expect(ids(resolved.hidden)).toEqual(["perf"])
  })

  it("honours a user reorder inside a zone", () => {
    const resolved = resolveBarLayout(catalog, {
      order: ["sync", "branch", "connectivity", ...DEFAULT_STATUS_BAR_LAYOUT.order],
      hidden: [],
    })
    expect(ids(resolved.zones.start)).toEqual(["sync", "branch", "connectivity"])
  })

  it("normalises a cross-zone drag back into the item's own zone", () => {
    // "runStatus" is an end-zone item dragged to the very front. It must not
    // render before the start-zone segments — it lands at its own zone's head.
    const resolved = resolveBarLayout(catalog, {
      order: ["runStatus", ...DEFAULT_STATUS_BAR_LAYOUT.order.filter((id) => id !== "runStatus")],
      hidden: [],
    })
    expect(ids(resolved.zones.start)).toEqual(["connectivity", "branch", "sync"])
    expect(ids(resolved.zones.end)[0]).toBe("runStatus")
    // …and the customizer list reads in exactly the render sequence.
    expect(ids(resolved.order)).toEqual([...ids(resolved.zones.start), ...ids(resolved.zones.end)])
  })

  it("keeps a hidden item's slot in the order list", () => {
    const resolved = resolveBarLayout(catalog, {
      order: DEFAULT_STATUS_BAR_LAYOUT.order,
      hidden: ["branch"],
    })
    expect(ids(resolved.order)).toContain("branch")
    expect(ids(resolved.zones.start)).toEqual(["connectivity", "sync"])
  })

  it("surfaces a catalog item the stored order never mentioned", () => {
    const resolved = resolveBarLayout(catalog, { order: ["runStatus"], hidden: [] })
    expect(ids(resolved.visible)).toContain("connectivity")
  })
})

describe("mergeVisibleOrder", () => {
  const order = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }]

  it("splices a reordered visible list back into the full order", () => {
    expect(mergeVisibleOrder(order, [], ["d", "c", "b", "a"])).toEqual(["d", "c", "b", "a"])
  })

  it("leaves every hidden id at the index it already holds", () => {
    // "b" is hidden, so it keeps slot 1; the visible ids fill 0, 2 and 3.
    expect(mergeVisibleOrder(order, [{ id: "b" }], ["c", "a", "d"])).toEqual(["c", "b", "a", "d"])
  })

  it("keeps a slot's own id when the visible list runs short", () => {
    // Defensive: the customizer always submits a permutation of the visible
    // ids, so a short list would mean the two views had drifted apart.
    expect(mergeVisibleOrder(order, [], ["d"])).toEqual(["d", "b", "c", "d"])
  })

  it("is a no-op for an empty order", () => {
    expect(mergeVisibleOrder([], [], [])).toEqual([])
  })
})

describe("isDefaultBarLayout", () => {
  it("is true for the shipped layouts", () => {
    const title = getBarCatalog("title", "tauri")
    expect(
      isDefaultBarLayout("title", title, resolveBarLayout(title, DEFAULT_TITLE_BAR_LAYOUT))
    ).toBe(true)
    const status = getBarCatalog("status", "tauri")
    expect(
      isDefaultBarLayout("status", status, resolveBarLayout(status, DEFAULT_STATUS_BAR_LAYOUT))
    ).toBe(true)
  })

  it("is false once an item is hidden", () => {
    const catalog = getBarCatalog("status", "tauri")
    const resolved = resolveBarLayout(catalog, {
      order: DEFAULT_STATUS_BAR_LAYOUT.order,
      hidden: [],
    })
    expect(isDefaultBarLayout("status", catalog, resolved)).toBe(false)
  })

  it("is false once an item is reordered", () => {
    const catalog = getBarCatalog("status", "tauri")
    const resolved = resolveBarLayout(catalog, {
      order: ["branch", "connectivity", "sync", ...DEFAULT_STATUS_BAR_LAYOUT.order],
      hidden: ["perf"],
    })
    expect(isDefaultBarLayout("status", catalog, resolved)).toBe(false)
  })

  it("ignores desktop-only ids that are absent from a web catalog", () => {
    const catalog = getBarCatalog("status", "web")
    const resolved = resolveBarLayout(catalog, DEFAULT_STATUS_BAR_LAYOUT)
    expect(isDefaultBarLayout("status", catalog, resolved)).toBe(true)
  })
})

describe("migrateLegacyBarItems", () => {
  it("returns null when the legacy map says nothing about this bar", () => {
    expect(migrateLegacyBarItems("title", {})).toBeNull()
    expect(migrateLegacyBarItems("title", { connectivity: false })).toBeNull()
  })

  it("carries a legacy opt-out over as a hidden id", () => {
    const migrated = migrateLegacyBarItems("status", { usage: false, perf: false })
    expect(migrated?.hidden.sort()).toEqual(["perf", "usage"])
  })

  it("lets an explicit legacy opt-in beat a hidden-by-default item", () => {
    const migrated = migrateLegacyBarItems("status", { perf: true })
    expect(migrated?.hidden).not.toContain("perf")
  })

  it("leaves unmentioned ids on their shipped default", () => {
    const migrated = migrateLegacyBarItems("title", { workspace: false })
    // `accountTop` / `quickActions` ship hidden and the legacy map is silent
    // about them, so they stay hidden rather than being force-shown.
    expect(migrated?.hidden.sort()).toEqual(["accountTop", "quickActions", "workspace"])
  })

  it("keeps the canonical order — the legacy map had none", () => {
    const migrated = migrateLegacyBarItems("status", { sync: false })
    expect(migrated?.order).toEqual(DEFAULT_STATUS_BAR_LAYOUT.order)
  })
})
