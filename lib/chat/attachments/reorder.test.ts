import { applyOrder, reorderIds, resolveDragEnd } from "./reorder"

describe("reorderIds", () => {
  it("moves an item forward into the target slot", () => {
    expect(reorderIds(["a", "b", "c", "d"], "a", "c")).toEqual(["b", "c", "a", "d"])
  })

  it("moves an item backward into the target slot", () => {
    expect(reorderIds(["a", "b", "c", "d"], "d", "b")).toEqual(["a", "d", "b", "c"])
  })

  it("swaps neighbours", () => {
    expect(reorderIds(["a", "b"], "b", "a")).toEqual(["b", "a"])
  })

  // Returning the SAME reference matters: the store uses this straight inside a
  // setState updater, and a fresh array would re-render on every no-op drag.
  it("returns the identical array when the drop is a no-op", () => {
    const ids = ["a", "b", "c"]
    expect(reorderIds(ids, "b", "b")).toBe(ids)
  })

  it("returns the identical array when either id is unknown", () => {
    const ids = ["a", "b"]
    expect(reorderIds(ids, "zz", "a")).toBe(ids)
    expect(reorderIds(ids, "a", "zz")).toBe(ids)
  })

  it("handles an empty list", () => {
    const ids: string[] = []
    expect(reorderIds(ids, "a", "b")).toBe(ids)
  })
})

describe("applyOrder", () => {
  const items = [{ id: "a" }, { id: "b" }, { id: "c" }]

  it("orders items by the id list", () => {
    expect(applyOrder(items, ["c", "a", "b"]).map((i) => i.id)).toEqual(["c", "a", "b"])
  })

  it("appends items the order list does not mention, preserving their input order", () => {
    // A file staged microseconds ago is in `items` but not yet in `order`.
    expect(applyOrder(items, ["c"]).map((i) => i.id)).toEqual(["c", "a", "b"])
  })

  it("ignores ids in the order list that no longer exist", () => {
    expect(applyOrder(items, ["gone", "b", "a", "c"]).map((i) => i.id)).toEqual(["b", "a", "c"])
  })

  it("returns an empty array for no items", () => {
    expect(applyOrder([], ["a"])).toEqual([])
  })

  it("falls back to input order when the order list is empty", () => {
    expect(applyOrder(items, []).map((i) => i.id)).toEqual(["a", "b", "c"])
  })
})

describe("resolveDragEnd", () => {
  it("commits onto a different chip", () => {
    expect(resolveDragEnd("a", "b")).toBe("b")
  })

  it("does not commit a drop onto itself", () => {
    expect(resolveDragEnd("a", "a")).toBeNull()
  })

  it("does not commit when the drag resolved no target", () => {
    expect(resolveDragEnd("a", null)).toBeNull()
    expect(resolveDragEnd("a", undefined)).toBeNull()
    expect(resolveDragEnd("a", "")).toBeNull()
  })
})
