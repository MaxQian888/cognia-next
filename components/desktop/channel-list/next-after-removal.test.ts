import { nextAfterRemoval } from "./next-after-removal"

const order = ["a", "b", "c", "d"]

describe("nextAfterRemoval", () => {
  it("opens the row below the removed open conversation", () => {
    expect(nextAfterRemoval(order, new Set(["b"]), "b")).toBe("c")
  })

  it("skips rows removed in the same action", () => {
    expect(nextAfterRemoval(order, new Set(["b", "c"]), "b")).toBe("d")
  })

  it("falls back to the nearest row above when nothing is left below", () => {
    expect(nextAfterRemoval(order, new Set(["c", "d"]), "d")).toBe("b")
  })

  it("returns null when every row goes", () => {
    expect(nextAfterRemoval(order, new Set(order), "a")).toBeNull()
  })

  it("returns null when the open conversation stays", () => {
    expect(nextAfterRemoval(order, new Set(["c"]), "a")).toBeNull()
    expect(nextAfterRemoval(order, new Set(["c"]), null)).toBeNull()
  })

  it("returns null when the open conversation is not rendered", () => {
    expect(nextAfterRemoval(order, new Set(["zz"]), "zz")).toBeNull()
  })
})
