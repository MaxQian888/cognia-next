import { estimateImageTokens } from "./image-tokens"

describe("estimateImageTokens", () => {
  it("is area over 750 for an image inside both limits", () => {
    expect(estimateImageTokens(750, 100)).toBe(100)
    expect(estimateImageTokens(1000, 1000)).toBe(1334)
  })

  it("fits the long edge and the megapixel cap before counting", () => {
    // 3136×1764 → 1568×882 = 1.38 MP → scaled to 1.15 MP.
    expect(estimateImageTokens(3136, 1764)).toBe(Math.ceil(1_150_000 / 750))
  })

  it("is zero for an unknown size", () => {
    expect(estimateImageTokens(0, 100)).toBe(0)
    expect(estimateImageTokens(Number.NaN, 100)).toBe(0)
  })
})
