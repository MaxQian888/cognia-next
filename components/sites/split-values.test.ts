import { splitValues } from "./split-values"

describe("splitValues", () => {
  it("splits on commas and newlines, trimming and dropping empties", () => {
    expect(splitValues("a, b\nc")).toEqual(["a", "b", "c"])
    expect(splitValues(" a ,\n, b ,\n\n")).toEqual(["a", "b"])
  })

  it("returns an empty array for a blank value", () => {
    expect(splitValues("")).toEqual([])
    expect(splitValues("  \n , ")).toEqual([])
  })
})
