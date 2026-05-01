/**
 * A2UI Constants Tests
 */

import {
  CATEGORY_KEYS,
  CATEGORY_I18N_MAP,
  surfaceStyles,
  contentStyles,
  ANALYSIS_TYPE_ICONS,
  ANALYSIS_TYPE_I18N_KEYS,
  ANALYSIS_TYPE_VALUES,
} from "./constants"

describe("CATEGORY_KEYS", () => {
  it("should contain expected category keys", () => {
    expect(CATEGORY_KEYS).toContain("productivity")
    expect(CATEGORY_KEYS).toContain("data")
    expect(CATEGORY_KEYS).toContain("form")
    expect(CATEGORY_KEYS).toContain("utility")
    expect(CATEGORY_KEYS).toContain("social")
  })

  it("should have 5 categories", () => {
    expect(CATEGORY_KEYS).toHaveLength(5)
  })
})

describe("CATEGORY_I18N_MAP", () => {
  it("should have an i18n key for every category", () => {
    for (const key of CATEGORY_KEYS) {
      expect(CATEGORY_I18N_MAP).toHaveProperty(key)
      expect(typeof CATEGORY_I18N_MAP[key]).toBe("string")
    }
  })

  it('should have i18n keys starting with "category"', () => {
    for (const value of Object.values(CATEGORY_I18N_MAP)) {
      expect(value).toMatch(/^category/)
    }
  })
})

describe("surfaceStyles", () => {
  it("should define styles for all surface types", () => {
    expect(surfaceStyles).toHaveProperty("inline")
    expect(surfaceStyles).toHaveProperty("dialog")
    expect(surfaceStyles).toHaveProperty("panel")
    expect(surfaceStyles).toHaveProperty("fullscreen")
  })

  it("should have string values for all surface types", () => {
    for (const value of Object.values(surfaceStyles)) {
      expect(typeof value).toBe("string")
    }
  })
})

describe("contentStyles", () => {
  it("should define styles for all surface types", () => {
    expect(contentStyles).toHaveProperty("inline")
    expect(contentStyles).toHaveProperty("dialog")
    expect(contentStyles).toHaveProperty("panel")
    expect(contentStyles).toHaveProperty("fullscreen")
  })

  it("should match surfaceStyles keys", () => {
    expect(Object.keys(contentStyles).sort()).toEqual(Object.keys(surfaceStyles).sort())
  })
})

describe("ANALYSIS_TYPE_ICONS", () => {
  it("should have an icon for every analysis type value", () => {
    for (const type of ANALYSIS_TYPE_VALUES) {
      expect(ANALYSIS_TYPE_ICONS).toHaveProperty(type)
      expect(typeof ANALYSIS_TYPE_ICONS[type]).toBe("string")
      expect(ANALYSIS_TYPE_ICONS[type].length).toBeGreaterThan(0)
    }
  })
})

describe("ANALYSIS_TYPE_I18N_KEYS", () => {
  it("should have an i18n key for every analysis type value", () => {
    for (const type of ANALYSIS_TYPE_VALUES) {
      expect(ANALYSIS_TYPE_I18N_KEYS).toHaveProperty(type)
      expect(typeof ANALYSIS_TYPE_I18N_KEYS[type]).toBe("string")
    }
  })

  it('should have i18n keys starting with "analysis"', () => {
    for (const value of Object.values(ANALYSIS_TYPE_I18N_KEYS)) {
      expect(value).toMatch(/^analysis/)
    }
  })
})

describe("ANALYSIS_TYPE_VALUES", () => {
  it("should be a non-empty array", () => {
    expect(Array.isArray(ANALYSIS_TYPE_VALUES)).toBe(true)
    expect(ANALYSIS_TYPE_VALUES.length).toBeGreaterThan(0)
  })

  it("should contain all expected analysis types", () => {
    const expected = [
      "summary",
      "key-insights",
      "methodology",
      "findings",
      "limitations",
      "future-work",
      "related-work",
      "technical-details",
      "comparison",
      "critique",
      "eli5",
      "custom",
    ]
    for (const type of expected) {
      expect(ANALYSIS_TYPE_VALUES).toContain(type)
    }
  })

  it("should contain unique values", () => {
    const unique = new Set(ANALYSIS_TYPE_VALUES)
    expect(unique.size).toBe(ANALYSIS_TYPE_VALUES.length)
  })

  it("should be consistent with ANALYSIS_TYPE_ICONS keys", () => {
    const iconKeys = Object.keys(ANALYSIS_TYPE_ICONS).sort()
    const values = [...ANALYSIS_TYPE_VALUES].sort()
    expect(values).toEqual(iconKeys)
  })

  it("should be consistent with ANALYSIS_TYPE_I18N_KEYS keys", () => {
    const i18nKeys = Object.keys(ANALYSIS_TYPE_I18N_KEYS).sort()
    const values = [...ANALYSIS_TYPE_VALUES].sort()
    expect(values).toEqual(i18nKeys)
  })
})
