import { formatCost } from "./cost-estimator"

describe("formatCost", () => {
  it("returns em-dash for null/undefined/NaN/Infinity", () => {
    expect(formatCost(null)).toBe("—")
    expect(formatCost(undefined)).toBe("—")
    expect(formatCost(NaN)).toBe("—")
    expect(formatCost(Infinity)).toBe("—")
  })

  it("returns $0 for exact zero", () => {
    expect(formatCost(0)).toBe("$0")
  })

  it("uses 4 decimal places for small amounts (< $0.01)", () => {
    expect(formatCost(0.0001)).toBe("$0.0001")
    expect(formatCost(0.0099)).toBe("$0.0099")
  })

  it("uses 2 decimal places for >= $0.01", () => {
    expect(formatCost(0.01)).toBe("$0.01")
    expect(formatCost(1.234)).toBe("$1.23")
    expect(formatCost(99.99)).toBe("$99.99")
  })

  it("returns em-dash when input is not a number", () => {
    expect(formatCost("0.5" as unknown as number)).toBe("—")
  })
})
