import { LEVEL_THEME, ALL_LEVELS, type ThemeColorKey } from "./level-theme"
import type { LogLevel } from "@/types/logging"

const VALID_CHART_KEYS: ThemeColorKey[] = [
  "success",
  "warning",
  "destructive",
  "muted-foreground",
  "chart-1",
  "chart-2",
  "chart-3",
  "chart-4",
  "chart-5",
]

describe("LEVEL_THEME", () => {
  it("covers every LogLevel", () => {
    const expected: LogLevel[] = ["trace", "debug", "info", "warn", "error", "fatal"]
    for (const level of expected) {
      expect(LEVEL_THEME[level]).toBeDefined()
    }
    expect(Object.keys(LEVEL_THEME).sort()).toEqual([...expected].sort())
  })

  it("uses semantic tokens — no hard-coded Tailwind palette", () => {
    const forbiddenPatterns = [
      /text-(gray|red|green|yellow|blue|emerald|amber|orange|purple|indigo|cyan)-/,
      /bg-(gray|red|green|yellow|blue|emerald|amber|orange|purple|indigo|cyan)-/,
      /border-(gray|red|green|yellow|blue|emerald|amber|orange|purple|indigo|cyan)-/,
      /\bdark:/,
    ]
    for (const [level, theme] of Object.entries(LEVEL_THEME)) {
      const joined = [theme.iconColor, theme.badgeClass, theme.gutterClass, theme.bgClass].join(" ")
      for (const pattern of forbiddenPatterns) {
        expect({ level, joined, pattern: pattern.source }).toMatchObject({ level })
        expect(joined).not.toMatch(pattern)
      }
    }
  })

  it("maps each level to a known chart color key", () => {
    for (const theme of Object.values(LEVEL_THEME)) {
      expect(VALID_CHART_KEYS).toContain(theme.chartColor)
    }
  })

  it("uses destructive token for error and fatal levels", () => {
    expect(LEVEL_THEME.error.iconColor).toBe("text-destructive")
    expect(LEVEL_THEME.fatal.iconColor).toBe("text-destructive")
    expect(LEVEL_THEME.error.chartColor).toBe("destructive")
    expect(LEVEL_THEME.fatal.chartColor).toBe("destructive")
  })

  it("uses warning token for warn level", () => {
    expect(LEVEL_THEME.warn.iconColor).toBe("text-warning")
    expect(LEVEL_THEME.warn.chartColor).toBe("warning")
  })

  it("uses success token for info level", () => {
    expect(LEVEL_THEME.info.iconColor).toBe("text-success")
    expect(LEVEL_THEME.info.chartColor).toBe("success")
  })

  it("uses muted tokens for trace level (lowest severity)", () => {
    expect(LEVEL_THEME.trace.iconColor).toBe("text-muted-foreground")
    expect(LEVEL_THEME.trace.chartColor).toBe("muted-foreground")
  })

  it("exposes a non-null icon component for every level", () => {
    for (const theme of Object.values(LEVEL_THEME)) {
      expect(theme.icon).toBeDefined()
      expect(typeof theme.icon).toBe("object")
    }
  })

  it("ALL_LEVELS lists every key in priority order", () => {
    expect(ALL_LEVELS).toEqual(["trace", "debug", "info", "warn", "error", "fatal"])
  })

  it("fatal carries the heaviest weight (font-semibold)", () => {
    expect(LEVEL_THEME.fatal.badgeClass).toContain("font-semibold")
    expect(LEVEL_THEME.error.badgeClass).not.toContain("font-semibold")
  })
})
