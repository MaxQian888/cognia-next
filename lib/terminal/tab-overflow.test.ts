import { hiddenTabIds, overflowEdges } from "./tab-overflow"

describe("hiddenTabIds", () => {
  const container = { left: 0, right: 100 }

  it("returns nothing when every tab fits", () => {
    expect(
      hiddenTabIds(container, [
        { id: "a", left: 0, right: 40 },
        { id: "b", left: 40, right: 90 },
      ])
    ).toEqual([])
  })

  it("counts a partially clipped tab as hidden", () => {
    // Half-clipped is exactly when the title becomes unreadable.
    expect(
      hiddenTabIds(container, [
        { id: "a", left: 0, right: 60 },
        { id: "b", left: 60, right: 130 },
      ])
    ).toEqual(["b"])
  })

  it("catches tabs scrolled off the leading edge too", () => {
    expect(
      hiddenTabIds(container, [
        { id: "a", left: -50, right: -10 },
        { id: "b", left: 0, right: 80 },
      ])
    ).toEqual(["a"])
  })

  it("tolerates sub-pixel overhang", () => {
    expect(hiddenTabIds(container, [{ id: "a", left: -0.2, right: 100.3 }])).toEqual([])
  })

  it("reports nothing for an unmeasured container instead of flashing the menu", () => {
    expect(hiddenTabIds({ left: 0, right: 0 }, [{ id: "a", left: 0, right: 40 }])).toEqual([])
  })
})

describe("overflowEdges", () => {
  it("shows no fades when the content fits", () => {
    expect(overflowEdges(0, 100, 100)).toEqual({ start: false, end: false })
    expect(overflowEdges(0, 80, 100)).toEqual({ start: false, end: false })
  })

  it("shows the end fade while there is more to the right", () => {
    expect(overflowEdges(0, 300, 100)).toEqual({ start: false, end: true })
  })

  it("shows both fades in the middle of the range", () => {
    expect(overflowEdges(100, 300, 100)).toEqual({ start: true, end: true })
  })

  it("drops the end fade at the far right, allowing for rounding", () => {
    expect(overflowEdges(200, 300, 100)).toEqual({ start: true, end: false })
    expect(overflowEdges(199.6, 300, 100)).toEqual({ start: true, end: false })
  })

  it("reports nothing for an unmeasured container", () => {
    expect(overflowEdges(0, 300, 0)).toEqual({ start: false, end: false })
  })
})
