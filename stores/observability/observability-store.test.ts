import { REFRESH_OPTIONS, useObservabilityStore, type PanelLayouts } from "./observability-store"

const initial = useObservabilityStore.getState()

beforeEach(() => {
  // Reset to defaults between tests (preserve action fns).
  useObservabilityStore.setState({
    layouts: null,
    rangePreset: "1h",
    customSince: null,
    customUntil: null,
    refreshMs: 10_000,
    filters: {},
    editMode: false,
    thresholds: {},
    hiddenPanels: [],
  })
})

describe("observability-store", () => {
  it("starts with sane defaults", () => {
    const s = useObservabilityStore.getState()
    expect(s.layouts).toBeNull()
    expect(s.rangePreset).toBe("1h")
    expect(s.refreshMs).toBe(10_000)
    expect(s.filters).toEqual({})
    expect(s.editMode).toBe(false)
  })

  it("exposes the allowed refresh cadences", () => {
    expect(REFRESH_OPTIONS).toContain(0)
    expect(REFRESH_OPTIONS).toContain(60_000)
  })

  it("sets and resets layouts", () => {
    const layouts: PanelLayouts = { lg: [{ i: "kpi", x: 0, y: 0, w: 12, h: 2 }], md: [], sm: [] }
    initial.setLayouts(layouts)
    expect(useObservabilityStore.getState().layouts).toEqual(layouts)
    initial.resetLayouts()
    expect(useObservabilityStore.getState().layouts).toBeNull()
  })

  it("sets a relative preset", () => {
    initial.setRangePreset("24h")
    expect(useObservabilityStore.getState().rangePreset).toBe("24h")
  })

  it("sets a custom range and flips preset to custom", () => {
    initial.setCustomRange(100, 200)
    const s = useObservabilityStore.getState()
    expect(s.rangePreset).toBe("custom")
    expect(s.customSince).toBe(100)
    expect(s.customUntil).toBe(200)
  })

  it("sets refresh cadence", () => {
    initial.setRefreshMs(30_000)
    expect(useObservabilityStore.getState().refreshMs).toBe(30_000)
  })

  it("sets filters", () => {
    initial.setFilters({ model: ["opus"] })
    expect(useObservabilityStore.getState().filters).toEqual({ model: ["opus"] })
  })

  it("toggles edit mode", () => {
    initial.setEditMode(true)
    expect(useObservabilityStore.getState().editMode).toBe(true)
  })

  it("sets and resets threshold overrides", () => {
    initial.setThreshold("cost", { warn: 3, crit: 9 })
    expect(useObservabilityStore.getState().thresholds.cost).toEqual({ warn: 3, crit: 9 })
    initial.setThreshold("errorRate", { warn: 0.1, crit: 0.4 })
    expect(Object.keys(useObservabilityStore.getState().thresholds)).toHaveLength(2)
    initial.resetThresholds()
    expect(useObservabilityStore.getState().thresholds).toEqual({})
  })

  it("sets and toggles panel visibility", () => {
    initial.setHiddenPanels(["ts-tokens"])
    expect(useObservabilityStore.getState().hiddenPanels).toEqual(["ts-tokens"])
    initial.togglePanelVisibility("kpi-cost")
    expect(useObservabilityStore.getState().hiddenPanels).toEqual(["ts-tokens", "kpi-cost"])
    initial.togglePanelVisibility("ts-tokens")
    expect(useObservabilityStore.getState().hiddenPanels).toEqual(["kpi-cost"])
  })

  it("applies an imported config", () => {
    initial.importConfig({
      version: 1,
      layouts: { lg: [{ i: "kpi-cost", x: 0, y: 0, w: 2, h: 2 }], md: [], sm: [] },
      hiddenPanels: ["traces"],
      thresholds: { cost: { warn: 1, crit: 2 } },
      rangePreset: "custom",
      customSince: 10,
      customUntil: 20,
      refreshMs: 30_000,
      filters: { model: ["opus"] },
    })
    const s = useObservabilityStore.getState()
    expect(s.rangePreset).toBe("custom")
    expect(s.customSince).toBe(10)
    expect(s.hiddenPanels).toEqual(["traces"])
    expect(s.thresholds.cost).toEqual({ warn: 1, crit: 2 })
    expect(s.filters).toEqual({ model: ["opus"] })
  })

  it("clears custom bounds when importing a relative preset", () => {
    initial.setCustomRange(1, 2)
    initial.importConfig({
      version: 1,
      layouts: null,
      hiddenPanels: [],
      thresholds: {},
      rangePreset: "6h",
      customSince: 999,
      customUntil: 1999,
      refreshMs: 10_000,
      filters: {},
    })
    const s = useObservabilityStore.getState()
    expect(s.rangePreset).toBe("6h")
    expect(s.customSince).toBeNull()
    expect(s.customUntil).toBeNull()
  })
})
