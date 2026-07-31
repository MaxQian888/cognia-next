import { pushRecent, toggleInList } from "./recency-list"

describe("pushRecent", () => {
  it("prepends a new item", () => {
    expect(pushRecent(["b"], "a", 5)).toEqual(["a", "b"])
  })

  it("dedupes — moves an existing item to the front", () => {
    expect(pushRecent(["a", "b", "c"], "c", 5)).toEqual(["c", "a", "b"])
  })

  it("caps at the limit, dropping the oldest", () => {
    expect(pushRecent(["b", "c", "d"], "a", 3)).toEqual(["a", "b", "c"])
  })

  it("does not mutate the input", () => {
    const input = ["a", "b"]
    pushRecent(input, "c", 5)
    expect(input).toEqual(["a", "b"])
  })
})

describe("toggleInList", () => {
  it("appends when absent", () => {
    expect(toggleInList(["a"], "b")).toEqual(["a", "b"])
  })

  it("removes when present, preserving order of the rest", () => {
    expect(toggleInList(["a", "b", "c"], "b")).toEqual(["a", "c"])
  })

  it("does not mutate the input", () => {
    const input = ["a"]
    toggleInList(input, "a")
    expect(input).toEqual(["a"])
  })
})
