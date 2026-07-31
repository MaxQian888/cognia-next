import {
  DASHBOARD_CONFIG_VERSION,
  parseDashboardConfig,
  serializeDashboardConfig,
  type DashboardConfig,
} from "./dashboard-config"

const fullConfig: DashboardConfig = {
  version: DASHBOARD_CONFIG_VERSION,
  layouts: {
    lg: [{ i: "kpi-cost", x: 0, y: 0, w: 2, h: 2 }],
    md: [],
    sm: [],
  },
  hiddenPanels: ["ts-tokens"],
  thresholds: { cost: { warn: 3, crit: 9 } },
  rangePreset: "6h",
  customSince: null,
  customUntil: null,
  refreshMs: 30_000,
  filters: { model: ["opus"] },
}

describe("dashboard-config", () => {
  it("round-trips a full config", () => {
    const parsed = parseDashboardConfig(serializeDashboardConfig(fullConfig))
    expect(parsed).toEqual(fullConfig)
  })

  it("returns null for non-JSON", () => {
    expect(parseDashboardConfig("{not json")).toBeNull()
  })

  it("returns null for a non-object root", () => {
    expect(parseDashboardConfig("[]")).toBeNull()
    expect(parseDashboardConfig("42")).toBeNull()
  })

  it("defaults missing fields so partial/older configs still import", () => {
    const parsed = parseDashboardConfig("{}")
    expect(parsed).toEqual({
      version: DASHBOARD_CONFIG_VERSION,
      layouts: null,
      hiddenPanels: [],
      thresholds: {},
      rangePreset: "1h",
      customSince: null,
      customUntil: null,
      refreshMs: 10_000,
      filters: {},
    })
  })

  it("rejects an out-of-set refresh cadence, falling back to the default", () => {
    const parsed = parseDashboardConfig(JSON.stringify({ refreshMs: 12345 }))
    expect(parsed?.refreshMs).toBe(10_000)
  })

  it("keeps a valid custom range", () => {
    const parsed = parseDashboardConfig(
      JSON.stringify({ rangePreset: "custom", customSince: 100, customUntil: 200 })
    )
    expect(parsed).toMatchObject({ rangePreset: "custom", customSince: 100, customUntil: 200 })
  })

  it("drops malformed layout items and non-string filter values", () => {
    const parsed = parseDashboardConfig(
      JSON.stringify({
        layouts: { lg: [{ i: "ok", x: 0, y: 0, w: 1, h: 1 }, { i: "bad" }], md: "nope" },
        filters: { model: ["opus", 5], surface: "nope" },
        hiddenPanels: ["a", 3],
      })
    )
    expect(parsed?.layouts?.lg).toHaveLength(1)
    expect(parsed?.layouts?.md).toEqual([])
    expect(parsed?.filters).toEqual({ model: ["opus"] })
    expect(parsed?.hiddenPanels).toEqual(["a"])
  })

  it("ignores threshold entries missing a numeric bound", () => {
    const parsed = parseDashboardConfig(
      JSON.stringify({ thresholds: { cost: { warn: 1 }, errorRate: { warn: 0.1, crit: 0.5 } } })
    )
    expect(parsed?.thresholds).toEqual({ errorRate: { warn: 0.1, crit: 0.5 } })
  })
})
