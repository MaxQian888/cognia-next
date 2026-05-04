import { wcagContrast } from "./contrast"

describe("wcagContrast", () => {
  it("returns ~21 for black on white", () => {
    expect(wcagContrast("#000000", "#ffffff")).toBeCloseTo(21, 0)
  })
  it("returns ~1 for same colors", () => {
    expect(wcagContrast("#888888", "#888888")).toBeCloseTo(1, 1)
  })
  it("is symmetric", () => {
    expect(wcagContrast("#123456", "#abcdef")).toBeCloseTo(wcagContrast("#abcdef", "#123456"), 2)
  })
})
