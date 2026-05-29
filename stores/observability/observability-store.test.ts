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
})
