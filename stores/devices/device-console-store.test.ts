import { useDeviceConsoleStore } from "./device-console-store"

const initial = useDeviceConsoleStore.getState()

beforeEach(() => {
  useDeviceConsoleStore.setState(initial, true)
})

describe("device console store", () => {
  it("starts with nothing selected and no filter", () => {
    const state = useDeviceConsoleStore.getState()
    expect(state.selectedRef).toBeNull()
    expect(state.kindFilter).toBe("all")
  })

  /**
   * The detail pane is one scroll, so there is no per-section state to carry
   * here, and no surface's open/closed flag either. Pinning that down: a future
   * re-addition of view state to this store has to justify itself against the
   * scroll position the pane already manages and the local `detailOpen`
   * `DevicesMobileBody` deliberately owns, rather than quietly reintroducing a
   * second source of "where am I".
   */
  it("holds no view state beyond selection, search and filter", () => {
    expect(Object.keys(useDeviceConsoleStore.getState()).sort()).toEqual([
      "kindFilter",
      "search",
      "select",
      "selectedRef",
      "setKindFilter",
      "setSearch",
    ])
  })

  it("keeps search and filter when the selection changes", () => {
    const state = useDeviceConsoleStore.getState()
    state.setSearch("phone")
    state.setKindFilter("remote-host")
    state.select("device:a")
    expect(useDeviceConsoleStore.getState()).toMatchObject({
      selectedRef: "device:a",
      search: "phone",
      kindFilter: "remote-host",
    })
  })

  it("clears the selection when handed null", () => {
    const state = useDeviceConsoleStore.getState()
    state.select("device:a")
    state.select(null)
    expect(useDeviceConsoleStore.getState().selectedRef).toBeNull()
  })
})
