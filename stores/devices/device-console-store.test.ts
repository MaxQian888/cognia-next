import { DEVICE_DETAIL_TABS, useDeviceConsoleStore } from "./device-console-store"

const initial = useDeviceConsoleStore.getState()

beforeEach(() => {
  useDeviceConsoleStore.setState(initial, true)
})

describe("device console store", () => {
  it("starts with nothing selected on Overview", () => {
    const state = useDeviceConsoleStore.getState()
    expect(state.selectedRef).toBeNull()
    expect(state.activeTab).toBe("overview")
    expect(state.kindFilter).toBe("all")
  })

  /**
   * Runtime for a phone is a tab whose whole content is "this kind of device
   * hosts nothing", so carrying the tab across a selection change makes the
   * console look broken exactly while it is being explored.
   */
  it("returns to Overview when a different device is selected", () => {
    const { select, setActiveTab } = useDeviceConsoleStore.getState()
    select("local")
    setActiveTab("runtime")
    select("device:a")
    expect(useDeviceConsoleStore.getState().activeTab).toBe("overview")
  })

  it("keeps the tab when the same device is re-selected", () => {
    const { select, setActiveTab } = useDeviceConsoleStore.getState()
    select("device:a")
    setActiveTab("access")
    select("device:a")
    expect(useDeviceConsoleStore.getState().activeTab).toBe("access")
  })

  it("closes the mobile list sheet on selection", () => {
    const { setListSheetOpen, select } = useDeviceConsoleStore.getState()
    setListSheetOpen(true)
    select("device:a")
    expect(useDeviceConsoleStore.getState().listSheetOpen).toBe(false)
  })

  it("clears back to the initial view", () => {
    const state = useDeviceConsoleStore.getState()
    state.select("device:a")
    state.setSearch("phone")
    state.setKindFilter("remote-host")
    state.reset()
    expect(useDeviceConsoleStore.getState()).toMatchObject({
      selectedRef: null,
      search: "",
      kindFilter: "all",
    })
  })

  it("lists the detail tabs in reading order", () => {
    expect(DEVICE_DETAIL_TABS).toEqual([
      "overview",
      "capabilities",
      "access",
      "runtime",
      "activity",
    ])
  })
})
