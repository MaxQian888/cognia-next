import { buildTimelineMarkers } from "./timeline-markers"

describe("buildTimelineMarkers", () => {
  it("bounds a dense rail while preserving its full range and highlighted buckets", () => {
    const count = 2_000
    const positions = Array.from({ length: count }, (_, index) => index / (count - 1))

    const markers = buildTimelineMarkers({
      count,
      positions,
      activeIndex: 1_101,
      bookmarkedIndices: new Set([777]),
      maxMarkers: 128,
    })

    expect(markers).toHaveLength(128)
    expect(markers[0]).toMatchObject({ position: 0 })
    expect(markers.at(-1)).toMatchObject({ position: 1 })
    expect(markers.some((marker) => marker.isActive)).toBe(true)
    expect(markers.some((marker) => marker.isBookmarked)).toBe(true)
  })

  it("keeps one marker per turn when the rail is already sparse", () => {
    const markers = buildTimelineMarkers({
      count: 3,
      positions: [0, 0.4, 1],
      activeIndex: 1,
      bookmarkedIndices: new Set([2]),
      maxMarkers: 128,
    })

    expect(markers).toEqual([
      { key: "0", position: 0, representativeIndex: 0, isActive: false, isBookmarked: false },
      { key: "1", position: 0.4, representativeIndex: 1, isActive: true, isBookmarked: false },
      { key: "2", position: 1, representativeIndex: 2, isActive: false, isBookmarked: true },
    ])
  })
})
