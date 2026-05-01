/**
 * A2UI Chart Constants Tests
 */

import { DEFAULT_CHART_COLORS, CHART_TOOLTIP_STYLE } from "./chart-constants"

describe("DEFAULT_CHART_COLORS", () => {
  it("should be an array of 5 colors", () => {
    expect(Array.isArray(DEFAULT_CHART_COLORS)).toBe(true)
    expect(DEFAULT_CHART_COLORS).toHaveLength(5)
  })

  it("should contain valid hex color strings", () => {
    for (const color of DEFAULT_CHART_COLORS) {
      expect(color).toMatch(/^#[0-9a-fA-F]{6}$/)
    }
  })

  it("should contain all unique colors", () => {
    const unique = new Set(DEFAULT_CHART_COLORS)
    expect(unique.size).toBe(DEFAULT_CHART_COLORS.length)
  })
})

describe("CHART_TOOLTIP_STYLE", () => {
  it("should have backgroundColor property", () => {
    expect(CHART_TOOLTIP_STYLE).toHaveProperty("backgroundColor")
    expect(typeof CHART_TOOLTIP_STYLE.backgroundColor).toBe("string")
  })

  it("should have border property", () => {
    expect(CHART_TOOLTIP_STYLE).toHaveProperty("border")
    expect(CHART_TOOLTIP_STYLE.border).toContain("solid")
  })

  it("should have borderRadius property", () => {
    expect(CHART_TOOLTIP_STYLE).toHaveProperty("borderRadius")
    expect(CHART_TOOLTIP_STYLE.borderRadius).toBe("6px")
  })

  it("should use CSS variable references for theming", () => {
    expect(CHART_TOOLTIP_STYLE.backgroundColor).toContain("var(--popover)")
    expect(CHART_TOOLTIP_STYLE.border).toContain("var(--border)")
  })
})
