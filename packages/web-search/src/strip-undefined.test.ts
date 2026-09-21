import { stripUndefined } from "./strip-undefined"

describe("stripUndefined", () => {
  it("drops undefined values and keeps defined ones", () => {
    expect(stripUndefined({ a: 1, b: undefined, c: false, d: null })).toEqual({
      a: 1,
      c: false,
      d: null,
    })
  })

  it("returns an empty object for an all-undefined input", () => {
    expect(stripUndefined({ a: undefined })).toEqual({})
  })

  it("does not mutate the input", () => {
    const input = { a: 1, b: undefined }
    stripUndefined(input)
    expect("b" in input).toBe(true)
  })
})
