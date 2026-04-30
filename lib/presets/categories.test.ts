import {
  PRESET_CATEGORIES,
  PRESET_CATEGORY_IDS,
  getCategoryLabel,
  getCategorySpec,
} from "./categories"

describe("PRESET_CATEGORIES", () => {
  it("exports the eight Cognia-aligned categories", () => {
    const ids = PRESET_CATEGORIES.map((c) => c.id).sort()
    expect(ids).toEqual(
      [
        "general",
        "coding",
        "writing",
        "research",
        "education",
        "business",
        "creative",
        "productivity",
      ].sort()
    )
  })

  it("PRESET_CATEGORY_IDS mirrors PRESET_CATEGORIES order", () => {
    expect(PRESET_CATEGORY_IDS).toEqual(PRESET_CATEGORIES.map((c) => c.id))
  })

  it("every category carries a labelKey + icon + tone", () => {
    for (const c of PRESET_CATEGORIES) {
      expect(c.labelKey).toBe(c.id)
      expect(typeof c.icon).toBe("object")
      expect(c.tone).toMatch(/^text-/)
    }
  })
})

describe("getCategorySpec", () => {
  it("looks up by id", () => {
    expect(getCategorySpec("coding")?.id).toBe("coding")
  })

  it("returns undefined for missing/unknown ids", () => {
    expect(getCategorySpec(undefined)).toBeUndefined()
  })
})

describe("getCategoryLabel", () => {
  it("uses the t resolver", () => {
    const t = (k: string) => (k === "presets.category.coding" ? "Programming" : k)
    expect(getCategoryLabel(t, "coding")).toBe("Programming")
  })

  it("falls back to the id when t echoes the key", () => {
    const t = (k: string) => k
    expect(getCategoryLabel(t, "coding")).toBe("coding")
  })

  it("returns the uncategorized label when category is undefined", () => {
    const t = (k: string) => (k === "presets.category.uncategorized" ? "(none)" : k)
    expect(getCategoryLabel(t, undefined)).toBe("(none)")
  })
})
