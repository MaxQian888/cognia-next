// Preference merging. The point of the field-by-field merge is that a blob
// written by a newer build (or hand-edited) can never put a value no reader
// understands into a window placement.

import {
  clampDockScale,
  DEFAULT_USAGE_DOCK_PREFERENCES,
  DOCK_EDGES,
  isVerticalEdge,
  MAX_DOCK_SCALE,
  MIN_DOCK_SCALE,
  mergeDockPreferences,
} from "./types"

describe("isVerticalEdge", () => {
  it("matches the axis each edge runs along", () => {
    expect(isVerticalEdge("left")).toBe(true)
    expect(isVerticalEdge("right")).toBe(true)
    expect(isVerticalEdge("top")).toBe(false)
    expect(isVerticalEdge("bottom")).toBe(false)
    expect(isVerticalEdge("floating")).toBe(false)
  })
})

describe("clampDockScale", () => {
  it("bounds the scale to what Rust also enforces", () => {
    expect(clampDockScale(0.1)).toBe(MIN_DOCK_SCALE)
    expect(clampDockScale(9)).toBe(MAX_DOCK_SCALE)
    expect(clampDockScale(1)).toBe(1)
  })

  it("defaults a non-number to 1 rather than propagating NaN into a placement", () => {
    expect(clampDockScale(Number.NaN)).toBe(1)
    expect(clampDockScale(Number.POSITIVE_INFINITY)).toBe(1)
  })
})

describe("mergeDockPreferences", () => {
  it("ships disabled, so an upgrade never opens a window nobody asked for", () => {
    expect(DEFAULT_USAGE_DOCK_PREFERENCES.enabled).toBe(false)
    expect(mergeDockPreferences(null).enabled).toBe(false)
    expect(mergeDockPreferences("nonsense")).toEqual(DEFAULT_USAGE_DOCK_PREFERENCES)
  })

  it("keeps known fields", () => {
    const merged = mergeDockPreferences({ enabled: true, edge: "left", scale: 0.8 })
    expect(merged).toMatchObject({ enabled: true, edge: "left", scale: 0.8 })
  })

  it("rejects an edge outside the vocabulary", () => {
    expect(mergeDockPreferences({ edge: "diagonal" }).edge).toBe(
      DEFAULT_USAGE_DOCK_PREFERENCES.edge
    )
  })

  it("clamps an out-of-range offset and scale", () => {
    expect(mergeDockPreferences({ offset: 9 }).offset).toBe(1)
    expect(mergeDockPreferences({ offset: -9 }).offset).toBe(0)
    expect(mergeDockPreferences({ scale: 99 }).scale).toBe(MAX_DOCK_SCALE)
  })

  it("drops non-string entries from the provider list", () => {
    expect(mergeDockPreferences({ providerIds: ["a", 3, null, "b"] }).providerIds).toEqual([
      "a",
      "b",
    ])
  })

  it("ignores a non-finite offset instead of writing NaN to a window position", () => {
    expect(mergeDockPreferences({ offset: Number.NaN }).offset).toBe(
      DEFAULT_USAGE_DOCK_PREFERENCES.offset
    )
  })

  it("declares five placements and no more", () => {
    expect(DOCK_EDGES).toEqual(["left", "right", "top", "bottom", "floating"])
  })
})
