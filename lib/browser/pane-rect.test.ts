import { getActivePaneRect, setActivePaneRect } from "@/lib/browser/pane-rect"

afterEach(() => setActivePaneRect(null))

describe("pane-rect singleton", () => {
  it("defaults to null", () => {
    expect(getActivePaneRect()).toBeNull()
  })

  it("stores and returns the published rect", () => {
    const rect = { x: 1, y: 2, width: 3, height: 4 }
    setActivePaneRect(rect)
    expect(getActivePaneRect()).toEqual(rect)
  })

  it("clears back to null", () => {
    setActivePaneRect({ x: 0, y: 0, width: 10, height: 10 })
    setActivePaneRect(null)
    expect(getActivePaneRect()).toBeNull()
  })
})
