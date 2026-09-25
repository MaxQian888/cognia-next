import {
  ISLAND_COLLAPSED_WIDTH,
  ISLAND_EXPANDED_WIDTH,
  ISLAND_NOTCH_COMPACT_EAR,
  ISLAND_NOTCH_MINIMAL_EAR,
  ISLAND_PILL_HEIGHT,
  islandContentHeight,
  islandLayout,
  islandWidth,
} from "./layout"

describe("islandLayout", () => {
  it("draws around the housing only where the OS located it", () => {
    expect(islandLayout({ topInset: 32, notchWidth: 200 })).toBe("notch")
    // A housing of unknown width cannot have content placed beside it.
    expect(islandLayout({ topInset: 32, notchWidth: 0 })).toBe("flat")
    expect(islandLayout({ topInset: 0, notchWidth: 0 })).toBe("flat")
    expect(islandLayout({ topInset: 0, notchWidth: 200 })).toBe("flat")
  })
})

describe("islandWidth", () => {
  it("keeps the flat pill and card widths", () => {
    expect(islandWidth("flat", "minimal", 0, true)).toBe(ISLAND_COLLAPSED_WIDTH)
    expect(islandWidth("flat", "compact", 0, true)).toBe(ISLAND_COLLAPSED_WIDTH)
    expect(islandWidth("flat", "expanded", 0, true)).toBe(ISLAND_EXPANDED_WIDTH)
  })

  it("is exactly the housing when minimal and idle, and grows ears for activity", () => {
    expect(islandWidth("notch", "minimal", 200, false)).toBe(200)
    expect(islandWidth("notch", "minimal", 200, true)).toBe(200 + 2 * ISLAND_NOTCH_MINIMAL_EAR)
  })

  it("never lets compact or expanded ears get narrower than a name needs", () => {
    expect(islandWidth("notch", "compact", 200, true)).toBe(ISLAND_COLLAPSED_WIDTH)
    expect(islandWidth("notch", "expanded", 200, true)).toBe(ISLAND_EXPANDED_WIDTH)
    // A wider housing widens the card instead of squeezing the ears.
    expect(islandWidth("notch", "compact", 260, true)).toBe(260 + 2 * ISLAND_NOTCH_COMPACT_EAR)
    expect(islandWidth("notch", "expanded", 400, true)).toBe(400 + 2 * ISLAND_NOTCH_COMPACT_EAR)
  })
})

describe("islandContentHeight", () => {
  it("lives in the housing strip unless expanded", () => {
    expect(islandContentHeight("notch", "minimal", 500, 32)).toBe(0)
    expect(islandContentHeight("notch", "compact", 500, 32)).toBe(0)
    // Expanded: only what hangs below the strip.
    expect(islandContentHeight("notch", "expanded", 332, 32)).toBe(300)
    expect(islandContentHeight("notch", "expanded", 10, 32)).toBe(0)
  })

  it("keeps the flat pill height and lets an expanded card grow from it", () => {
    expect(islandContentHeight("flat", "compact", 500, 0)).toBe(ISLAND_PILL_HEIGHT)
    expect(islandContentHeight("flat", "minimal", 500, 0)).toBe(ISLAND_PILL_HEIGHT)
    expect(islandContentHeight("flat", "expanded", 300, 0)).toBe(300)
    expect(islandContentHeight("flat", "expanded", 20, 0)).toBe(ISLAND_PILL_HEIGHT)
  })
})
