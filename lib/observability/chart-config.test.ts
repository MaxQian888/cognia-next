import {
  TOOLTIP_STYLE,
  CHART_MARGINS,
  CHART_COLORS,
  EXTENDED_COLORS,
  PERCENTILE_COLORS,
  TOKEN_COLORS,
  GRID_STYLE,
  AXIS_STYLE,
} from "./chart-config"

describe("chart-config constants", () => {
  it("TOOLTIP_STYLE has the expected sub-styles", () => {
    expect(TOOLTIP_STYLE.contentStyle).toBeDefined()
    expect(TOOLTIP_STYLE.labelStyle).toBeDefined()
    expect(TOOLTIP_STYLE.itemStyle).toBeDefined()
  })

  it("TOOLTIP_STYLE references theme vars directly (no invalid hsl(oklch) wrapper)", () => {
    // The theme tokens are oklch; `hsl(var(--popover))` → `hsl(oklch(…))` is
    // invalid and gets dropped. The HTML tooltip div resolves bare `var()`.
    expect(TOOLTIP_STYLE.contentStyle.backgroundColor).toBe("var(--popover)")
    expect(TOOLTIP_STYLE.contentStyle.border).toContain("var(--border)")
    expect(JSON.stringify(TOOLTIP_STYLE)).not.toContain("hsl(var(")
  })

  it("CHART_MARGINS has all four named presets", () => {
    expect(CHART_MARGINS.default.top).toBeDefined()
    expect(CHART_MARGINS.withYAxis.left).toBeDefined()
    expect(CHART_MARGINS.compact.bottom).toBeDefined()
    expect(CHART_MARGINS.vertical.right).toBeDefined()
  })

  it("CHART_COLORS exposes named slots for every chart series", () => {
    for (const k of [
      "primary",
      "secondary",
      "tertiary",
      "quaternary",
      "success",
      "warning",
      "error",
      "info",
    ]) {
      expect((CHART_COLORS as Record<string, string>)[k]).toMatch(/^#/)
    }
  })

  it("EXTENDED_COLORS is non-empty", () => {
    expect(EXTENDED_COLORS.length).toBeGreaterThan(5)
    EXTENDED_COLORS.forEach((c) => expect(c).toMatch(/^#/))
  })

  it("PERCENTILE_COLORS has p50/p90/p99", () => {
    expect(PERCENTILE_COLORS.p50).toMatch(/^#/)
    expect(PERCENTILE_COLORS.p90).toMatch(/^#/)
    expect(PERCENTILE_COLORS.p99).toMatch(/^#/)
  })

  it("TOKEN_COLORS has input/output", () => {
    expect(TOKEN_COLORS.input).toMatch(/^#/)
    expect(TOKEN_COLORS.output).toMatch(/^#/)
  })

  it("GRID_STYLE / AXIS_STYLE expose the expected fields", () => {
    expect(GRID_STYLE.strokeDasharray).toBeDefined()
    expect(AXIS_STYLE.tick).toBeDefined()
    expect(AXIS_STYLE.axisLine).toBeDefined()
  })
})
