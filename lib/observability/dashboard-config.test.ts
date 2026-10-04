import type { PanelLayouts } from "@/stores/observability/observability-store"
import {
  DASHBOARD_CONFIG_VERSION,
  normalizePanelLayouts,
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

  it("keeps the provider and project cost-attribution filters", () => {
    const parsed = parseDashboardConfig(
      JSON.stringify({
        filters: { provider: ["anthropic", "openai"], project: ["p1"], model: ["opus"] },
      })
    )
    expect(parsed?.filters).toEqual({
      provider: ["anthropic", "openai"],
      project: ["p1"],
      model: ["opus"],
    })
  })

  it("sanitizes imported filters (unknown dimensions, empty lists, duplicates)", () => {
    const parsed = parseDashboardConfig(
      JSON.stringify({
        filters: { provider: ["anthropic", "anthropic", ""], project: [], nope: ["x"] },
      })
    )
    expect(parsed?.filters).toEqual({ provider: ["anthropic"] })
  })

  it("round-trips a config carrying provider and project filters", () => {
    const cfg: DashboardConfig = {
      ...fullConfig,
      filters: { provider: ["anthropic"], project: ["p1", "p2"] },
    }
    expect(parseDashboardConfig(serializeDashboardConfig(cfg))).toEqual(cfg)
  })
})

describe("normalizePanelLayouts", () => {
  const defaults: PanelLayouts = {
    lg: [
      { i: "kpi-cost", x: 0, y: 0, w: 3, h: 2, minW: 2, minH: 2 },
      { i: "ts-cost", x: 3, y: 0, w: 6, h: 4, minW: 4, minH: 3 },
    ],
    md: [{ i: "kpi-cost", x: 0, y: 0, w: 2, h: 2, minW: 2, minH: 2 }],
    sm: [{ i: "kpi-cost", x: 0, y: 0, w: 1, h: 2 }],
  }

  it("returns the defaults for a null or undefined layout", () => {
    expect(normalizePanelLayouts(null, defaults)).toEqual(defaults)
    expect(normalizePanelLayouts(undefined, defaults)).toEqual(defaults)
  })

  it("returns fresh copies, not the default items themselves", () => {
    const out = normalizePanelLayouts(null, defaults)
    expect(out.lg[0]).not.toBe(defaults.lg[0])
    out.lg[0].x = 99
    expect(defaults.lg[0].x).toBe(0)
  })

  it("fills panels missing at a breakpoint from the defaults, min sizes included", () => {
    const out = normalizePanelLayouts(
      { lg: [{ i: "kpi-cost", x: 6, y: 1, w: 3, h: 2 }], md: [], sm: [] },
      defaults
    )
    expect(out.lg).toEqual([
      { i: "kpi-cost", x: 6, y: 1, w: 3, h: 2, minW: 2, minH: 2 },
      { i: "ts-cost", x: 3, y: 0, w: 6, h: 4, minW: 4, minH: 3 },
    ])
    expect(out.md).toEqual(defaults.md)
    expect(out.sm).toEqual(defaults.sm)
  })

  it("keeps a stored position", () => {
    const out = normalizePanelLayouts(
      { lg: [{ i: "ts-cost", x: 5, y: 7, w: 7, h: 5 }], md: [], sm: [] },
      defaults
    )
    expect(out.lg[0]).toEqual({ i: "ts-cost", x: 5, y: 7, w: 7, h: 5, minW: 4, minH: 3 })
  })

  it("clamps an undersized item up to the default minW / minH", () => {
    const out = normalizePanelLayouts(
      { lg: [{ i: "ts-cost", x: 0, y: 0, w: 1, h: 1 }], md: [], sm: [] },
      defaults
    )
    expect(out.lg[0]).toMatchObject({ w: 4, h: 3, minW: 4, minH: 3 })
  })

  it("re-asserts the default min sizes over edited ones", () => {
    const out = normalizePanelLayouts(
      { lg: [{ i: "ts-cost", x: 0, y: 0, w: 1, h: 1, minW: 1, minH: 1 }], md: [], sm: [] },
      defaults
    )
    expect(out.lg[0]).toMatchObject({ w: 4, h: 3, minW: 4, minH: 3 })
  })

  it("uses 1x1 as the floor when the default declares no minimum", () => {
    const out = normalizePanelLayouts(
      { lg: [], md: [], sm: [{ i: "kpi-cost", x: 0, y: 0, w: 0, h: -2 }] },
      defaults
    )
    expect(out.sm[0]).toEqual({ i: "kpi-cost", x: 0, y: 0, w: 1, h: 1, minW: 1, minH: 1 })
  })

  it("clamps negative and non-finite coordinates to zero", () => {
    const out = normalizePanelLayouts(
      {
        lg: [
          { i: "kpi-cost", x: -4, y: -1, w: 3, h: 2 },
          { i: "ts-cost", x: Number.NaN, y: Number.POSITIVE_INFINITY, w: Number.NaN, h: 5 },
        ],
        md: [],
        sm: [],
      },
      defaults
    )
    expect(out.lg[0]).toMatchObject({ x: 0, y: 0 })
    expect(out.lg[1]).toMatchObject({ x: 0, y: 0, w: 4, h: 5 })
  })

  it("drops ids the registry no longer knows", () => {
    const out = normalizePanelLayouts(
      {
        lg: [
          { i: "traces", x: 0, y: 34, w: 12, h: 8 },
          { i: "kpi-cost", x: 0, y: 0, w: 3, h: 2 },
        ],
        md: [],
        sm: [],
      },
      defaults
    )
    expect(out.lg.map((item) => item.i)).toEqual(["kpi-cost", "ts-cost"])
  })

  it("keeps only the first of duplicated ids", () => {
    const out = normalizePanelLayouts(
      {
        lg: [
          { i: "kpi-cost", x: 1, y: 1, w: 3, h: 2 },
          { i: "kpi-cost", x: 9, y: 9, w: 3, h: 2 },
        ],
        md: [],
        sm: [],
      },
      defaults
    )
    expect(out.lg.filter((item) => item.i === "kpi-cost")).toEqual([
      { i: "kpi-cost", x: 1, y: 1, w: 3, h: 2, minW: 2, minH: 2 },
    ])
  })

  it("tolerates a breakpoint missing from the stored layout", () => {
    const partial = { lg: [] } as unknown as PanelLayouts
    expect(normalizePanelLayouts(partial, defaults)).toEqual(defaults)
  })
})
