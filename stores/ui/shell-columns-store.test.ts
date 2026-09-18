import { act } from "@testing-library/react"
import { useShellColumnsStore } from "./shell-columns-store"

beforeEach(() => {
  act(() =>
    useShellColumnsStore.setState({
      widths: { rail: 0, sidebar: 0, dock: 0 },
      targets: { rail: null, sidebar: null, dock: null },
      sidebarHostsNav: false,
      sidebarNavHostCount: 0,
    })
  )
})

describe("useShellColumnsStore", () => {
  it("starts every column at zero — nothing measured, nothing on screen", () => {
    expect(useShellColumnsStore.getState().widths).toEqual({ rail: 0, sidebar: 0, dock: 0 })
  })

  it("records a column's rendered width without touching the other", () => {
    act(() => useShellColumnsStore.getState().setColumnWidth("sidebar", 296))
    expect(useShellColumnsStore.getState().widths).toEqual({ rail: 0, sidebar: 296, dock: 0 })
    act(() => useShellColumnsStore.getState().setColumnWidth("dock", 412.6))
    // Rounded: the bar sizes its zones in whole pixels, and a sub-pixel echo
    // from a ResizeObserver must not re-render every subscriber.
    expect(useShellColumnsStore.getState().widths).toEqual({ rail: 0, sidebar: 296, dock: 413 })
    act(() => useShellColumnsStore.getState().setColumnWidth("rail", 56))
    expect(useShellColumnsStore.getState().widths.rail).toBe(56)
  })

  it("clamps negative measurements to zero", () => {
    act(() => useShellColumnsStore.getState().setColumnWidth("dock", -4))
    expect(useShellColumnsStore.getState().widths.dock).toBe(0)
  })

  it("is identity-stable when the width has not changed", () => {
    act(() => useShellColumnsStore.getState().setColumnWidth("sidebar", 300))
    const before = useShellColumnsStore.getState()
    act(() => useShellColumnsStore.getState().setColumnWidth("sidebar", 300.2))
    expect(useShellColumnsStore.getState()).toBe(before)
  })

  it("publishes a gesture target per column and clears it independently of widths", () => {
    const state = () => useShellColumnsStore.getState()
    expect(state().targets).toEqual({ rail: null, sidebar: null, dock: null })

    act(() => state().setColumnTarget("sidebar", 0))
    expect(state().targets).toEqual({ rail: null, sidebar: 0, dock: null })
    // A target is not a measurement: the rendered width stays untouched so a
    // subscriber can always see both where the column is and where it lands.
    expect(state().widths.sidebar).toBe(0)

    act(() => state().setColumnTarget("sidebar", null))
    expect(state().targets.sidebar).toBeNull()
  })

  it("is identity-stable when the target has not changed", () => {
    act(() => useShellColumnsStore.getState().setColumnTarget("dock", 384))
    const before = useShellColumnsStore.getState()
    act(() => useShellColumnsStore.getState().setColumnTarget("dock", 384))
    expect(useShellColumnsStore.getState()).toBe(before)
  })

  it("records whether the expanded sidebar is hosting the navigation, as a refcount", () => {
    const state = () => useShellColumnsStore.getState()
    expect(state().sidebarHostsNav).toBe(false)
    const releaseA = state().registerSidebarNavHost()
    expect(state().sidebarHostsNav).toBe(true)
    expect(state().sidebarNavHostCount).toBe(1)
    // A second sidebar (route transition, remount) overlaps the first: the
    // navigation stays hosted until the *last* claim is released, whatever
    // order the cleanups run in.
    const releaseB = state().registerSidebarNavHost()
    expect(state().sidebarNavHostCount).toBe(2)
    releaseA()
    expect(state().sidebarHostsNav).toBe(true)
    releaseB()
    expect(state().sidebarHostsNav).toBe(false)
    expect(state().sidebarNavHostCount).toBe(0)
  })

  it("releases a claim once, however many times its disposer is called", () => {
    const state = () => useShellColumnsStore.getState()
    const releaseA = state().registerSidebarNavHost()
    state().registerSidebarNavHost()
    releaseA()
    releaseA()
    expect(state().sidebarNavHostCount).toBe(1)
    expect(state().sidebarHostsNav).toBe(true)
  })
})
