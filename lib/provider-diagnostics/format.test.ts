import { formatMs, formatNumber, formatCostUsd } from "./format"

describe("formatMs", () => {
  it("rounds to whole milliseconds", () => {
    expect(formatMs(12.4)).toBe("12 ms")
    expect(formatMs(12.6)).toBe("13 ms")
  })

  it("renders an em dash for undefined rather than NaN", () => {
    expect(formatMs(undefined)).toBe("—")
  })

  it("keeps zero as a real measurement", () => {
    expect(formatMs(0)).toBe("0 ms")
  })

  it("stays in milliseconds for large durations so matrix rows stay comparable", () => {
    expect(formatMs(125_000)).toBe("125000 ms")
  })
})

describe("formatNumber", () => {
  it("uses two decimals by default", () => {
    expect(formatNumber(3.14159)).toBe("3.14")
  })

  it("honours an explicit precision", () => {
    expect(formatNumber(3.14159, 4)).toBe("3.1416")
  })

  it("renders an em dash for undefined", () => {
    expect(formatNumber(undefined)).toBe("—")
  })

  it("keeps zero as a real measurement", () => {
    expect(formatNumber(0)).toBe("0.00")
  })
})

describe("formatCostUsd", () => {
  it("renders six decimals by default — diagnostics costs are sub-cent", () => {
    expect(formatCostUsd(0.0000125)).toBe("$0.000013")
  })

  it("honours an explicit precision", () => {
    expect(formatCostUsd(1.5, 2)).toBe("$1.50")
  })

  it("renders an em dash when no estimate exists", () => {
    expect(formatCostUsd(undefined)).toBe("—")
  })

  it("keeps a free run as $0, not an em dash", () => {
    expect(formatCostUsd(0)).toBe("$0.000000")
  })
})
