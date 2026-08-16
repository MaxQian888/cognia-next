import { act } from "@testing-library/react"
import { useShellColumnsStore } from "./shell-columns-store"

beforeEach(() => {
  act(() => useShellColumnsStore.setState({ widths: { sidebar: 0, dock: 0 } }))
})

describe("useShellColumnsStore", () => {
  it("starts every column at zero — nothing measured, nothing on screen", () => {
    expect(useShellColumnsStore.getState().widths).toEqual({ sidebar: 0, dock: 0 })
  })

  it("records a column's rendered width without touching the other", () => {
    act(() => useShellColumnsStore.getState().setColumnWidth("sidebar", 296))
    expect(useShellColumnsStore.getState().widths).toEqual({ sidebar: 296, dock: 0 })
    act(() => useShellColumnsStore.getState().setColumnWidth("dock", 412.6))
    // Rounded: the bar sizes its zones in whole pixels, and a sub-pixel echo
    // from a ResizeObserver must not re-render every subscriber.
    expect(useShellColumnsStore.getState().widths).toEqual({ sidebar: 296, dock: 413 })
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
})
