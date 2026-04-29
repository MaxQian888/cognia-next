import { SKILL_CATEGORIES, SKILL_SOURCES, getCategoryMeta, getSourceMeta } from "./categories"

describe("category metadata", () => {
  it("exposes 8 categories", () => {
    expect(SKILL_CATEGORIES).toHaveLength(8)
  })

  it("returns the matching meta for a known category", () => {
    expect(getCategoryMeta("development").labelKey).toBe("development")
    expect(getCategoryMeta("creative-design").labelKey).toBe("creativeDesign")
  })

  it("falls back to custom for unknown / undefined categories", () => {
    expect(getCategoryMeta(undefined).id).toBe("custom")
    // @ts-expect-error — purposefully passing an invalid value to test fallback
    expect(getCategoryMeta("nonsense").id).toBe("custom")
  })
})

describe("source metadata", () => {
  it("exposes the 5 known sources", () => {
    expect(SKILL_SOURCES.map((s) => s.id).sort()).toEqual(
      ["builtin", "custom", "generated", "imported", "marketplace"].sort()
    )
  })

  it("returns the matching meta for a known source", () => {
    expect(getSourceMeta("builtin").labelKey).toBe("builtin")
    expect(getSourceMeta("marketplace").labelKey).toBe("marketplace")
  })

  it("falls back to custom for unknown / undefined sources", () => {
    expect(getSourceMeta(undefined).id).toBe("custom")
    // @ts-expect-error — purposefully passing an invalid value to test fallback
    expect(getSourceMeta("nonsense").id).toBe("custom")
  })
})
