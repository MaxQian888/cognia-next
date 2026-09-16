import {
  MoneyError,
  addMicrousd,
  costForQuantity,
  costPerCall,
  microusdToUsd,
  parseDecimal,
  subtractMicrousdFloor,
  usdToMicrousd,
} from "./microusd"

describe("microusd money", () => {
  it("parses API money strings exactly", () => {
    expect(usdToMicrousd("0.500000")).toBe(500000)
    expect(usdToMicrousd("1")).toBe(1_000_000)
    expect(usdToMicrousd("0.000001")).toBe(1)
    expect(usdToMicrousd("999999.999999")).toBe(999_999_999_999)
  })

  it("refuses more than six decimals and malformed input", () => {
    for (const bad of ["0.0000001", "-1", "1e3", "01", " 1", "", "1."]) {
      expect(() => usdToMicrousd(bad)).toThrow(MoneyError)
    }
  })

  it("formats with exactly six fractional digits", () => {
    expect(microusdToUsd(0)).toBe("0.000000")
    expect(microusdToUsd(1)).toBe("0.000001")
    expect(microusdToUsd(1_500_000)).toBe("1.500000")
    expect(() => microusdToUsd(1.5)).toThrow(MoneyError)
    expect(() => microusdToUsd(-1)).toThrow(MoneyError)
  })

  it("rounds each bucket up to the next microusd", () => {
    // 1234 tokens at $0.10 / 1M = 123.4 microusd → 124
    expect(costForQuantity(1234, "0.10")).toBe(124)
    expect(costForQuantity(1000, "0.10")).toBe(100)
    expect(costForQuantity(0, "15.00")).toBe(0)
    expect(costForQuantity(5, "0")).toBe(0)
    expect(costPerCall(3, "0.01")).toBe(30000)
    expect(costPerCall(1, "0.0000001")).toBe(1)
  })

  it("[ACC:BUD-08] accumulates tiny rates over many calls with no float error", () => {
    let total = 0
    for (let i = 0; i < 100_000; i++) total = addMicrousd(total, costForQuantity(1, "0.000001"))
    // Each call is ceil(1e-6) = 1 microusd; floats would drift, integers do not.
    expect(total).toBe(100_000)
    expect(microusdToUsd(total)).toBe("0.100000")
    let floatTotal = 0
    for (let i = 0; i < 100_000; i++) floatTotal += 0.000001
    expect(floatTotal).not.toBe(0.1)
  })

  it("keeps scale exact for long decimals", () => {
    expect(parseDecimal("3.000000000001")).toEqual({
      numerator: BigInt("3000000000001"),
      scale: 12,
    })
    expect(costForQuantity(1_000_000, "3.000000000001")).toBe(3_000_001)
  })

  it("guards the safe integer range and clamps subtraction explicitly", () => {
    expect(() => addMicrousd(Number.MAX_SAFE_INTEGER, 1)).toThrow(MoneyError)
    expect(() => addMicrousd(-1)).toThrow(MoneyError)
    expect(() => costForQuantity(-1, "1")).toThrow(MoneyError)
    expect(() => costPerCall(0.5, "1")).toThrow(MoneyError)
    expect(subtractMicrousdFloor(5, 7)).toBe(0)
    expect(subtractMicrousdFloor(7, 5)).toBe(2)
  })
})
