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
   * or reset here. Pinning that down: a future re-addition of view state to this
   * store has to justify itself against the scroll position the pane already
   * manages, rather than quietly reintroducing two sources of "where am I".
   */
  it("holds no view state beyond selection, search and filter", () => {
    expect(Object.keys(useDeviceConsoleStore.getState()).sort()).toEqual([
      "kindFilter",
      "listSheetOpen",
      "reset",
      "search",
      "select",
      "selectedRef",
      "setKindFilter",
      "setListSheetOpen",
      "setSearch",
    ])
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
})
