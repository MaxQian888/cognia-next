import { useLogWorkspaceStore } from "./log-workspace-store"

beforeEach(() => {
  useLogWorkspaceStore.getState().resetWorkspace()
})

describe("log-workspace-store", () => {
  it("starts in the plain-language health view", () => {
    const state = useLogWorkspaceStore.getState()
    expect(state.activeView).toBe("health")
    expect(state.density).toBe("comfortable")
    expect(state.navigationCollapsed).toBe(false)
  })

  it("persists bounded pane dimensions", () => {
    const state = useLogWorkspaceStore.getState()
    state.setNavigationWidth(999)
    state.setDetailWidth(10)

    expect(useLogWorkspaceStore.getState().navigationWidth).toBe(360)
    expect(useLogWorkspaceStore.getState().detailWidth).toBe(280)
  })

  it("updates the active view, source, filters, density, and collapsed state", () => {
    const state = useLogWorkspaceStore.getState()
    state.setActiveView("incidents")
    state.setActiveSource("mobile")
    state.setIncidentStateFilter("accepted")
    state.setDensity("compact")
    state.setNavigationCollapsed(true)

    expect(useLogWorkspaceStore.getState()).toMatchObject({
      activeView: "incidents",
      activeSource: "mobile",
      incidentStateFilter: "accepted",
      density: "compact",
      navigationCollapsed: true,
    })
  })

  it("resets all device-local workspace preferences", () => {
    const state = useLogWorkspaceStore.getState()
    state.setActiveView("advanced")
    state.setNavigationWidth(340)
    state.setDetailWidth(600)
    state.setNavigationCollapsed(true)
    state.resetWorkspace()

    expect(useLogWorkspaceStore.getState()).toMatchObject({
      activeView: "health",
      navigationWidth: 248,
      detailWidth: 384,
      navigationCollapsed: false,
      activeSource: "all",
      incidentStateFilter: "all",
    })
  })
})
