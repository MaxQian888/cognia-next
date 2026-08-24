import { sanitizePromotionSegment } from "./promotion"

describe("sanitizePromotionSegment", () => {
  it("normalizes branch-unsafe text and preserves safe characters", () => {
    expect(sanitizePromotionSegment(" Alice / docs.v2 ")).toBe("Alice-docs.v2")
  })

  it("uses a stable fallback for an empty segment", () => {
    expect(sanitizePromotionSegment("///")).toBe("x")
  })
})
