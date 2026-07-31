import { partitionByLayout, resolveOrderedLayout } from "@/lib/shell/layout-partition"

interface Item {
  id: string
}

const catalog: Item[] = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }]

describe("partitionByLayout", () => {
  it("keeps pinned ids in user order, rest in catalog order as overflow", () => {
    const { pinned, overflow, hidden } = partitionByLayout(catalog, {
      pinned: ["c", "a"],
      hidden: [],
    })
    expect(pinned.map((i) => i.id)).toEqual(["c", "a"])
    expect(overflow.map((i) => i.id)).toEqual(["b", "d"])
    expect(hidden).toEqual([])
  })

  it("partitions hidden ids that are not pinned, in catalog order", () => {
    const { pinned, overflow, hidden } = partitionByLayout(catalog, {
      pinned: ["a"],
      hidden: ["d", "b"],
    })
    expect(pinned.map((i) => i.id)).toEqual(["a"])
    expect(overflow.map((i) => i.id)).toEqual(["c"])
    expect(hidden.map((i) => i.id)).toEqual(["b", "d"])
  })

  it("lets pinned win over hidden when an id appears in both", () => {
    const { pinned, hidden } = partitionByLayout(catalog, {
      pinned: ["b"],
      hidden: ["b"],
    })
    expect(pinned.map((i) => i.id)).toEqual(["b"])
    expect(hidden.map((i) => i.id)).not.toContain("b")
  })

  it("dedupes duplicate pinned ids and drops unknown ids", () => {
    const { pinned, overflow } = partitionByLayout(catalog, {
      pinned: ["a", "a", "zzz"],
      hidden: ["nope"],
    })
    expect(pinned.map((i) => i.id)).toEqual(["a"])
    expect(overflow.map((i) => i.id)).toEqual(["b", "c", "d"])
  })

  it("defaults everything to overflow for an empty layout", () => {
    const { pinned, overflow, hidden } = partitionByLayout(catalog, { pinned: [], hidden: [] })
    expect(pinned).toEqual([])
    expect(hidden).toEqual([])
    expect(overflow.map((i) => i.id)).toEqual(["a", "b", "c", "d"])
  })
})

describe("resolveOrderedLayout", () => {
  it("keeps the stored order and splits out the hidden ids", () => {
    const { order, visible, hidden } = resolveOrderedLayout(catalog, {
      order: ["c", "a", "b", "d"],
      hidden: ["a"],
    })
    expect(order.map((i) => i.id)).toEqual(["c", "a", "b", "d"])
    expect(visible.map((i) => i.id)).toEqual(["c", "b", "d"])
    expect(hidden.map((i) => i.id)).toEqual(["a"])
  })

  it("appends catalog items the stored order never mentioned", () => {
    const { order, visible } = resolveOrderedLayout(catalog, { order: ["d"], hidden: [] })
    expect(order.map((i) => i.id)).toEqual(["d", "a", "b", "c"])
    expect(visible.map((i) => i.id)).toEqual(["d", "a", "b", "c"])
  })

  it("dedupes the stored order and drops unknown ids from both arrays", () => {
    const { order, hidden } = resolveOrderedLayout(catalog, {
      order: ["b", "b", "zzz", "a"],
      hidden: ["nope", "a"],
    })
    expect(order.map((i) => i.id)).toEqual(["b", "a", "c", "d"])
    expect(hidden.map((i) => i.id)).toEqual(["a"])
  })

  it("keeps a hidden item's slot so unhiding restores its position", () => {
    const withHidden = resolveOrderedLayout(catalog, { order: ["a", "b", "c", "d"], hidden: ["b"] })
    expect(withHidden.order.map((i) => i.id)).toEqual(["a", "b", "c", "d"])

    const unhidden = resolveOrderedLayout(catalog, {
      order: withHidden.order.map((i) => i.id),
      hidden: [],
    })
    expect(unhidden.visible.map((i) => i.id)).toEqual(["a", "b", "c", "d"])
  })

  it("falls back to catalog order for an empty layout", () => {
    const { visible, hidden } = resolveOrderedLayout(catalog, { order: [], hidden: [] })
    expect(visible.map((i) => i.id)).toEqual(["a", "b", "c", "d"])
    expect(hidden).toEqual([])
  })
})
