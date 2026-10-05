import { sameValue, stableJson } from "./stable-json"

describe("stableJson / sameValue", () => {
  it("ignores object key order and undefined members", () => {
    expect(stableJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: undefined } })).toBe(
      '{"a":{"d":[1,{"x":1,"y":2}]},"b":1}'
    )
    expect(sameValue({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true)
  })

  it("treats null and undefined as the same unset value", () => {
    expect(sameValue(undefined, null)).toBe(true)
    expect(sameValue({ a: null }, { a: undefined })).toBe(false)
    expect(sameValue([undefined], [null])).toBe(true)
  })

  it("tells real changes apart", () => {
    expect(sameValue("a", "b")).toBe(false)
    expect(sameValue([1, 2], [2, 1])).toBe(false)
    expect(sameValue({ a: 1 }, { a: "1" })).toBe(false)
    expect(sameValue(new Date(0), new Date(0))).toBe(true)
  })
})
