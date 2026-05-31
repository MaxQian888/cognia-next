import { partitionByLayout } from "@/lib/shell/layout-partition"

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
