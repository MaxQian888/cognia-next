/** @jest-environment jsdom */

import {
  DEFAULT_DETAIL_WIDTH,
  DETAIL_WIDTH_MAX,
  DETAIL_WIDTH_MIN,
  INCIDENT_STATE_FILTERS,
  migrateLogWorkspace,
  resolveIncidentStateFilter,
  resolveLogWorkspaceView,
  resolveTraceSubView,
  useLogWorkspaceStore,
} from "./log-workspace-store"

beforeEach(() => {
  useLogWorkspaceStore.getState().resetWorkspace()
})

describe("log-workspace-store", () => {
  it("opens on the logs channel — the page's actual subject", () => {
    const state = useLogWorkspaceStore.getState()
    expect(state.activeView).toBe("logs")
    expect(state.density).toBe("comfortable")
    expect(state.receiptsOnly).toBe(false)
    expect(state.traceSubView).toBe("explore")
  })

  it("clamps the incident detail pane width", () => {
    useLogWorkspaceStore.getState().setDetailWidth(9999)
    expect(useLogWorkspaceStore.getState().detailWidth).toBe(DETAIL_WIDTH_MAX)
    useLogWorkspaceStore.getState().setDetailWidth(1)
    expect(useLogWorkspaceStore.getState().detailWidth).toBe(DETAIL_WIDTH_MIN)
  })

  it("updates every channel and filter setter", () => {
    const state = useLogWorkspaceStore.getState()
    state.setActiveView("traces")
    state.setActiveSource("mobile")
    state.setIncidentStateFilter("accepted")
    state.setReceiptsOnly(true)
    state.setDensity("compact")
    state.setTraceSubView("dashboard")
    state.setTraceErrorsOnly(true)

    expect(useLogWorkspaceStore.getState()).toMatchObject({
      activeView: "traces",
      activeSource: "mobile",
      incidentStateFilter: "accepted",
      receiptsOnly: true,
      density: "compact",
      traceSubView: "dashboard",
      traceErrorsOnly: true,
    })
  })

  it("resets all device-local workspace preferences", () => {
    const state = useLogWorkspaceStore.getState()
    state.setActiveView("incidents")
    state.setDetailWidth(600)
    state.setReceiptsOnly(true)
    state.setTraceErrorsOnly(true)
    state.resetWorkspace()

    expect(useLogWorkspaceStore.getState()).toMatchObject({
      activeView: "logs",
      detailWidth: 384,
      receiptsOnly: false,
      activeSource: "all",
      incidentStateFilter: "all",
      traceSubView: "explore",
      traceErrorsOnly: false,
    })
  })
})

describe("resolveLogWorkspaceView", () => {
  it("accepts every channel and rejects anything else", () => {
    expect(resolveLogWorkspaceView("traces")).toBe("traces")
    expect(resolveLogWorkspaceView("diagnostics")).toBe("diagnostics")
    expect(resolveLogWorkspaceView("incidents")).toBe("incidents")
    expect(resolveLogWorkspaceView("health")).toBe("logs")
    expect(resolveLogWorkspaceView(null)).toBe("logs")
    expect(resolveLogWorkspaceView("incidents", "traces")).toBe("incidents")
  })
})

describe("resolveTraceSubView", () => {
  it("accepts the two sub-views and rejects anything else", () => {
    expect(resolveTraceSubView("dashboard")).toBe("dashboard")
    expect(resolveTraceSubView("explore")).toBe("explore")
    expect(resolveTraceSubView("nope")).toBe("explore")
    expect(resolveTraceSubView(null)).toBe("explore")
    expect(resolveTraceSubView(undefined, "dashboard")).toBe("dashboard")
  })
})

describe("migrateLogWorkspace", () => {
  it("moves the three deleted static views onto the logs channel", () => {
    for (const view of ["health", "recovery", "advanced"]) {
      expect(migrateLogWorkspace({ activeView: view }).activeView).toBe("logs")
    }
  })

  it("turns the receipts view into an incidents filter", () => {
    expect(migrateLogWorkspace({ activeView: "receipts" })).toMatchObject({
      activeView: "incidents",
      receiptsOnly: true,
    })
  })

  it("keeps surviving preferences and drops the removed rail keys", () => {
    const migrated = migrateLogWorkspace({
      activeView: "incidents",
      density: "spacious",
      detailWidth: 512,
      activeSource: "mobile",
      incidentStateFilter: "queued",
      navigationWidth: 300,
      navigationCollapsed: true,
    })
    expect(migrated).toMatchObject({
      activeView: "incidents",
      density: "spacious",
      detailWidth: 512,
      activeSource: "mobile",
      incidentStateFilter: "queued",
    })
    expect(migrated).not.toHaveProperty("navigationWidth")
    expect(migrated).not.toHaveProperty("navigationCollapsed")
  })

  it("drops the v2 trace window — the shared Grafana range replaced it", () => {
    const migrated = migrateLogWorkspace({ activeView: "traces", traceWindow: "month" })
    expect(migrated).not.toHaveProperty("traceWindow")
    expect(migrated.traceSubView).toBe("explore")
  })

  it("restores a persisted sub-view and rejects a hostile one", () => {
    expect(migrateLogWorkspace({ traceSubView: "dashboard" }).traceSubView).toBe("dashboard")
    expect(migrateLogWorkspace({ traceSubView: "charts" }).traceSubView).toBe("explore")
  })

  it("clamps and defaults hostile persisted values", () => {
    expect(
      migrateLogWorkspace({ detailWidth: 5000, density: "huge", activeSource: "satellite" })
    ).toMatchObject({
      detailWidth: DETAIL_WIDTH_MAX,
      density: "comfortable",
      activeSource: "all",
      activeView: "logs",
    })
  })

  it("survives a missing or non-object blob", () => {
    expect(migrateLogWorkspace(undefined)).toEqual({})
    expect(migrateLogWorkspace("nope")).toEqual({})
  })
})

describe("incident state vocabulary", () => {
  it("speaks the service's snake_case lifecycle, packaged included", () => {
    expect(INCIDENT_STATE_FILTERS[0]).toBe("all")
    expect(INCIDENT_STATE_FILTERS).toContain("awaiting_consent")
    expect(INCIDENT_STATE_FILTERS).toContain("packaged")
    expect(INCIDENT_STATE_FILTERS).not.toContain("awaitingConsent")
  })

  it("resolves legacy and hostile filter values", () => {
    expect(resolveIncidentStateFilter("all")).toBe("all")
    expect(resolveIncidentStateFilter("awaitingConsent")).toBe("awaiting_consent")
    expect(resolveIncidentStateFilter("packaged")).toBe("packaged")
    expect(resolveIncidentStateFilter("nonsense")).toBe("all")
    expect(resolveIncidentStateFilter(42)).toBe("all")
  })

  it("migrates a v3 camelCase state filter onto the service vocabulary", () => {
    expect(migrateLogWorkspace({ incidentStateFilter: "awaitingConsent" })).toMatchObject({
      incidentStateFilter: "awaiting_consent",
    })
    expect(migrateLogWorkspace({ incidentStateFilter: "bogus" })).toMatchObject({
      incidentStateFilter: "all",
    })
  })
})

describe("errors channel filters", () => {
  it("keeps the filters in the store so a channel switch does not reset them", () => {
    const state = useLogWorkspaceStore.getState()
    state.setCrashSource("persisted")
    state.setCrashLevel("fatal")
    state.setCrashSearch("chunk")
    state.setActiveView("logs")
    state.setActiveView("diagnostics")
    expect(useLogWorkspaceStore.getState()).toMatchObject({
      crashSource: "persisted",
      crashLevel: "fatal",
      crashSearch: "chunk",
    })
    state.resetWorkspace()
    expect(useLogWorkspaceStore.getState()).toMatchObject({
      crashSource: "all",
      crashLevel: "all",
      crashSearch: "",
    })
  })

  it("restores persisted source and level and rejects hostile ones", () => {
    expect(migrateLogWorkspace({ crashSource: "recent", crashLevel: "error" })).toMatchObject({
      crashSource: "recent",
      crashLevel: "error",
    })
    expect(migrateLogWorkspace({ crashSource: "disk", crashLevel: "loud" })).toMatchObject({
      crashSource: "all",
      crashLevel: "all",
    })
  })

  it("never persists the search text", () => {
    useLogWorkspaceStore.getState().setCrashSearch("secret-ish query")
    const raw = localStorage.getItem("cognia-log-workspace-v1")
    expect(raw).not.toBeNull()
    expect(raw).not.toContain("secret-ish query")
    expect(JSON.parse(raw as string).version).toBe(4)
  })

  it("exports the shared detail-pane bounds", () => {
    expect(DETAIL_WIDTH_MIN).toBeLessThan(DEFAULT_DETAIL_WIDTH)
    expect(DEFAULT_DETAIL_WIDTH).toBeLessThan(DETAIL_WIDTH_MAX)
    expect(useLogWorkspaceStore.getState().detailWidth).toBe(DEFAULT_DETAIL_WIDTH)
  })
})
