import { coerceNum, getAtPath, numAtPath } from "./path"

describe("getAtPath", () => {
  const root = {
    data: { balance: 12.5, infos: [{ total: 100 }, { total: 200 }] },
    rate_limit: { primary_window: { used_percent: 42 } },
    nullish: null,
  }

  it("walks object keys", () => {
    expect(getAtPath(root, "data.balance")).toBe(12.5)
    expect(getAtPath(root, "rate_limit.primary_window.used_percent")).toBe(42)
  })

  it("indexes arrays by numeric segment", () => {
    expect(getAtPath(root, "data.infos.0.total")).toBe(100)
    expect(getAtPath(root, "data.infos.1.total")).toBe(200)
  })

  it("returns undefined for missing keys, out-of-range indices, and non-traversable values", () => {
    expect(getAtPath(root, "data.missing")).toBeUndefined()
    expect(getAtPath(root, "data.infos.5.total")).toBeUndefined()
    expect(getAtPath(root, "data.infos.-1")).toBeUndefined()
    expect(getAtPath(root, "data.balance.deeper")).toBeUndefined()
    expect(getAtPath(root, "nullish.x")).toBeUndefined()
  })

  it("returns undefined for empty path or non-object root", () => {
    expect(getAtPath(root, "")).toBeUndefined()
    expect(getAtPath(null, "a")).toBeUndefined()
    expect(getAtPath(42, "a")).toBeUndefined()
  })
})

describe("coerceNum", () => {
  it("passes finite numbers through", () => {
    expect(coerceNum(0)).toBe(0)
    expect(coerceNum(-3.2)).toBe(-3.2)
  })

  it("parses numeric strings", () => {
    expect(coerceNum("12.34")).toBe(12.34)
    expect(coerceNum("  5 ")).toBe(5)
  })

  it("rejects non-finite, empty, and non-numeric values", () => {
    expect(coerceNum(NaN)).toBeNull()
    expect(coerceNum(Infinity)).toBeNull()
    expect(coerceNum("")).toBeNull()
    expect(coerceNum("   ")).toBeNull()
    expect(coerceNum("abc")).toBeNull()
    expect(coerceNum(null)).toBeNull()
    expect(coerceNum({})).toBeNull()
    expect(coerceNum(true)).toBeNull()
  })
})

describe("numAtPath", () => {
  it("reads a numeric value at a path (string|number tolerant)", () => {
    expect(numAtPath({ a: { b: "7" } }, "a.b")).toBe(7)
    expect(numAtPath({ a: { b: 7 } }, "a.b")).toBe(7)
  })

  it("returns null for missing path or undefined path arg", () => {
    expect(numAtPath({ a: 1 }, "x")).toBeNull()
    expect(numAtPath({ a: 1 }, undefined)).toBeNull()
  })
})
