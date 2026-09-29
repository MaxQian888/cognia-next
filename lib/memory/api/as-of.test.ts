import { parseMemoryAsOf } from "./as-of"

describe("parseMemoryAsOf", () => {
  it("returns undefined when absent", () => {
    expect(parseMemoryAsOf(undefined)).toBeUndefined()
  })

  it("accepts epoch milliseconds as-is", () => {
    expect(parseMemoryAsOf(1_700_000_000_000)).toBe(1_700_000_000_000)
  })

  it("parses an ISO 8601 timestamp", () => {
    expect(parseMemoryAsOf("2024-01-02T03:04:05.000Z")).toBe(Date.UTC(2024, 0, 2, 3, 4, 5))
  })

  it.each([
    ["an unparseable string", "not a date"],
    ["zero", 0],
    ["a negative epoch", -5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["an empty string", ""],
  ])("throws on %s", (_label, value) => {
    expect(() => parseMemoryAsOf(value as number | string)).toThrow(
      /asOf must be epoch milliseconds or an ISO 8601 timestamp/
    )
  })
})
