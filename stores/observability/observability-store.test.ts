/**
 * @jest-environment jsdom
 */
// jsdom: `resetView` rewrites the address bar through `window.history`.
import {
  OBSERVABILITY_URL_PARAMS,
  REFRESH_OPTIONS,
  migrateObservabilityView,
  useObservabilityStore,
  type PanelLayouts,
} from "./observability-store"

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
    timelineScale: "duration",
    timelineGrouping: "operation",
    timelineCollapsed: false,
    timelineZoom: null,
    exploreQuery: "",
    exploreSpanId: null,
  })
  window.history.replaceState({}, "", "/logs")
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

  it("starts the timeline and Explore state at their shipped defaults", () => {
    const s = useObservabilityStore.getState()
    expect(s.timelineScale).toBe("duration")
    expect(s.timelineGrouping).toBe("operation")
    expect(s.timelineCollapsed).toBe(false)
    expect(s.timelineZoom).toBeNull()
    expect(s.exploreQuery).toBe("")
    expect(s.exploreSpanId).toBeNull()
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

  it("sets the timeline scale, grouping and collapse", () => {
    initial.setTimelineScale("sequence")
    initial.setTimelineGrouping("model")
    initial.setTimelineCollapsed(true)
    const s = useObservabilityStore.getState()
    expect(s.timelineScale).toBe("sequence")
    expect(s.timelineGrouping).toBe("model")
    expect(s.timelineCollapsed).toBe(true)
  })

  it("pins a timeline zoom to its trace, and clears it with a null window", () => {
    initial.setTimelineZoom("t1", { since: 10, until: 20 })
    expect(useObservabilityStore.getState().timelineZoom).toEqual({
      traceId: "t1",
      window: { since: 10, until: 20 },
    })
    initial.setTimelineZoom("t1", null)
    expect(useObservabilityStore.getState().timelineZoom).toBeNull()
  })

  it("sets the Explore search and open span", () => {
    initial.setExploreQuery("bash")
    initial.setExploreSpanId("s1")
    expect(useObservabilityStore.getState().exploreQuery).toBe("bash")
    expect(useObservabilityStore.getState().exploreSpanId).toBe("s1")
    initial.setExploreSpanId(null)
    expect(useObservabilityStore.getState().exploreSpanId).toBeNull()
  })

  it("persists preferences but keeps edit mode, zoom and Explore state transient", () => {
    const partialize = useObservabilityStore.persist.getOptions().partialize!
    const s0 = useObservabilityStore.getState()
    s0.setTimelineZoom("t1", { since: 1, until: 2 })
    s0.setExploreQuery("bash")
    s0.setExploreSpanId("s1")
    s0.setEditMode(true)
    s0.setTimelineScale("sequence")
    const persisted = partialize(useObservabilityStore.getState()) as Record<string, unknown>
    expect(Object.keys(persisted).sort()).toEqual(
      [
        "layouts",
        "rangePreset",
        "customSince",
        "customUntil",
        "refreshMs",
        "filters",
        "thresholds",
        "hiddenPanels",
        "timelineScale",
        "timelineGrouping",
        "timelineCollapsed",
      ].sort()
    )
    expect(persisted).not.toHaveProperty("timelineZoom")
    expect(persisted).not.toHaveProperty("exploreQuery")
    expect(persisted).not.toHaveProperty("exploreSpanId")
    expect(persisted).not.toHaveProperty("editMode")
    expect(persisted.timelineScale).toBe("sequence")
  })

  it("names the t-prefixed keys the Traces syncs own, without the shell's tview", () => {
    expect([...OBSERVABILITY_URL_PARAMS]).toEqual([
      "trange",
      "tfrom",
      "tto",
      "tf",
      "tspan",
      "tq",
      "terr",
    ])
    expect(OBSERVABILITY_URL_PARAMS).not.toContain("tview")
  })

  it("resetView restores every persisted field to its shipped default", () => {
    const s0 = useObservabilityStore.getState()
    s0.setCustomRange(10, 20)
    s0.setRefreshMs(30_000)
    s0.setFilters({ model: ["opus"], provider: ["anthropic"] })
    s0.setThreshold("cost", { warn: 9, crit: 99 })
    s0.setHiddenPanels(["ts-cost"])
    s0.setLayouts({ lg: [{ i: "kpi-cost", x: 1, y: 1, w: 2, h: 2 }], md: [], sm: [] })
    s0.setEditMode(true)

    useObservabilityStore.getState().resetView()

    const s = useObservabilityStore.getState()
    expect(s.layouts).toBeNull()
    expect(s.rangePreset).toBe("1h")
    expect(s.customSince).toBeNull()
    expect(s.customUntil).toBeNull()
    expect(s.refreshMs).toBe(10_000)
    expect(s.filters).toEqual({})
    expect(s.thresholds).toEqual({})
    expect(s.hiddenPanels).toEqual([])
    expect(s.editMode).toBe(false)
  })

  it("resetView also restores the timeline and Explore state", () => {
    const s0 = useObservabilityStore.getState()
    s0.setTimelineScale("sequence")
    s0.setTimelineGrouping("agent")
    s0.setTimelineCollapsed(true)
    s0.setTimelineZoom("t1", { since: 1, until: 2 })
    s0.setExploreQuery("bash")
    s0.setExploreSpanId("s1")

    useObservabilityStore.getState().resetView()

    const s = useObservabilityStore.getState()
    expect(s.timelineScale).toBe("duration")
    expect(s.timelineGrouping).toBe("operation")
    expect(s.timelineCollapsed).toBe(false)
    expect(s.timelineZoom).toBeNull()
    expect(s.exploreQuery).toBe("")
    expect(s.exploreSpanId).toBeNull()
  })

  it("resetView clears the owned and legacy params from a traces URL, leaving foreign ones", () => {
    window.history.replaceState(
      {},
      "",
      "/logs?channel=traces&traceId=t1&tview=dashboard&trange=custom&tfrom=1&tto=2&tf=x" +
        "&tspan=s1&tq=bash&terr=1"
    )
    useObservabilityStore.getState().resetView()
    expect(window.location.pathname).toBe("/logs")
    const p = new URLSearchParams(window.location.search)
    for (const key of OBSERVABILITY_URL_PARAMS) expect(p.has(key)).toBe(false)
    expect(p.get("channel")).toBe("traces")
    expect(p.get("traceId")).toBe("t1")
    // The sub-view belongs to the /logs shell, which resets it itself.
    expect(p.get("tview")).toBe("dashboard")
  })

  it("resetView clears pre-rename legacy params on a channel=traces link", () => {
    window.history.replaceState(
      {},
      "",
      "/logs?channel=traces&traceId=t1&range=custom&from=1&to=2&f=x"
    )
    useObservabilityStore.getState().resetView()
    const p = new URLSearchParams(window.location.search)
    for (const legacy of ["range", "from", "to", "f"]) expect(p.has(legacy)).toBe(false)
    expect(p.toString()).toBe("channel=traces&traceId=t1")
  })

  it("resetView leaves from/to alone on a non-traces URL (they are the Logs panel's)", () => {
    window.history.replaceState({}, "", "/logs?channel=logs&from=1&to=2&range=6h&trange=24h")
    useObservabilityStore.getState().resetView()
    expect(new URLSearchParams(window.location.search).toString()).toBe(
      "channel=logs&from=1&to=2&range=6h"
    )
  })

  it("resetView drops the query string entirely when nothing else is left", () => {
    window.history.replaceState({}, "", "/logs?trange=6h&tq=bash")
    useObservabilityStore.getState().resetView()
    expect(window.location.search).toBe("")
    expect(window.location.pathname).toBe("/logs")
  })
})

describe("migrateObservabilityView", () => {
  const v0 = {
    // Written before the registry gained kpi-rate / kpi-tools /
    // kpi-tool-failures / bd-operation / bd-tool and lost `traces`.
    layouts: {
      lg: [
        { i: "kpi-cost", x: 0, y: 0, w: 3, h: 2 },
        { i: "traces", x: 0, y: 34, w: 12, h: 8 },
      ],
      md: [],
      sm: [],
    },
    rangePreset: "6h",
    refreshMs: 30_000,
    filters: { model: ["opus"] },
    thresholds: { cost: { warn: 1, crit: 2 } },
    hiddenPanels: ["traces", "ts-cost"],
  }

  it("drops a layout written before the panel registry changed shape", () => {
    // Left in place, the saved layout has no entry for the five new panels and
    // react-grid-layout would stack them as 1x1 tiles at the bottom of the grid.
    expect(migrateObservabilityView(v0, 0).layouts).toBeNull()
  })

  it("keeps everything the user actually chose", () => {
    const next = migrateObservabilityView(v0, 0)
    expect(next.rangePreset).toBe("6h")
    expect(next.refreshMs).toBe(30_000)
    expect(next.filters).toEqual({ model: ["opus"] })
    expect(next.thresholds).toEqual({ cost: { warn: 1, crit: 2 } })
  })

  it("forgets the removed panel's hidden-state entry", () => {
    // `traces` is not a panel any more, so carrying its id would push it into
    // every exported DashboardConfig from here on.
    expect(migrateObservabilityView(v0, 0).hiddenPanels).toEqual(["ts-cost"])
  })

  it("passes a current snapshot through untouched", () => {
    const current = { ...v0, layouts: { lg: [], md: [], sm: [] } }
    expect(migrateObservabilityView(current, 1)).toBe(current)
  })

  it("survives an absent or empty snapshot", () => {
    expect(migrateObservabilityView(undefined, 0)).toEqual({ layouts: null, hiddenPanels: [] })
  })
})
