import { useMcpPanelStore } from "./mcp-panel-store"

function reset() {
  useMcpPanelStore.setState({
    activeTab: "my-servers",
    search: "",
    transportFilter: "all",
    statusFilter: "all",
    selection: new Set<string>(),
    editorTarget: null,
    deleteTarget: null,
    filterSheetOpen: false,
  })
}

describe("useMcpPanelStore", () => {
  beforeEach(reset)

  it("starts on the my-servers tab with no filters", () => {
    const s = useMcpPanelStore.getState()
    expect(s.activeTab).toBe("my-servers")
    expect(s.search).toBe("")
    expect(s.transportFilter).toBe("all")
    expect(s.statusFilter).toBe("all")
    expect(s.selection.size).toBe(0)
  })

  it("switches tabs and sets filters", () => {
    const { setActiveTab, setSearch, setTransportFilter, setStatusFilter } =
      useMcpPanelStore.getState()
    setActiveTab("health")
    setSearch("git")
    setTransportFilter("stdio")
    setStatusFilter("enabled")
    const s = useMcpPanelStore.getState()
    expect(s.activeTab).toBe("health")
    expect(s.search).toBe("git")
    expect(s.transportFilter).toBe("stdio")
    expect(s.statusFilter).toBe("enabled")
  })

  it("resets filters without touching the active tab", () => {
    const { setActiveTab, setSearch, setTransportFilter, resetFilters } =
      useMcpPanelStore.getState()
    setActiveTab("presets")
    setSearch("x")
    setTransportFilter("http")
    resetFilters()
    const s = useMcpPanelStore.getState()
    expect(s.search).toBe("")
    expect(s.transportFilter).toBe("all")
    expect(s.statusFilter).toBe("all")
    expect(s.activeTab).toBe("presets")
  })

  it("toggles selection membership idempotently", () => {
    const { toggleSelection } = useMcpPanelStore.getState()
    toggleSelection("a")
    expect(useMcpPanelStore.getState().selection.has("a")).toBe(true)
    toggleSelection("a")
    expect(useMcpPanelStore.getState().selection.has("a")).toBe(false)
  })

  it("selectAll replaces the set and clearSelection empties it", () => {
    const { selectAll, clearSelection } = useMcpPanelStore.getState()
    selectAll(["a", "b", "c"])
    expect(useMcpPanelStore.getState().selection.size).toBe(3)
    clearSelection()
    expect(useMcpPanelStore.getState().selection.size).toBe(0)
  })

  it("opens create / edit editor targets and closes them", () => {
    const { openCreate, openEdit, closeEditor } = useMcpPanelStore.getState()
    openCreate()
    expect(useMcpPanelStore.getState().editorTarget).toMatchObject({ mode: "create" })
    openCreate({ name: "x", transport: "stdio", config: {}, enabled: true, appsEnabled: {} })
    expect(useMcpPanelStore.getState().editorTarget).toMatchObject({
      mode: "create",
      seed: { name: "x" },
    })
    openEdit("srv1")
    expect(useMcpPanelStore.getState().editorTarget).toEqual({ mode: "edit", serverId: "srv1" })
    closeEditor()
    expect(useMcpPanelStore.getState().editorTarget).toBeNull()
  })

  it("tracks the delete target and the mobile filter sheet", () => {
    const { setDeleteTarget, setFilterSheetOpen } = useMcpPanelStore.getState()
    setDeleteTarget({ serverId: "srv1", name: "github" })
    expect(useMcpPanelStore.getState().deleteTarget).toEqual({ serverId: "srv1", name: "github" })
    setDeleteTarget(null)
    expect(useMcpPanelStore.getState().deleteTarget).toBeNull()
    setFilterSheetOpen(true)
    expect(useMcpPanelStore.getState().filterSheetOpen).toBe(true)
  })
})
