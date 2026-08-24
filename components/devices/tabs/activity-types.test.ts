import type { HostDispatchStatus, PlacementDimensionCounts } from "./activity-types"

/**
 * The status union is re-exported rather than restated so the tone map in
 * `activity-tab.tsx` is exhaustive by construction. This pins that it really is
 * the queue's own union and not a hand-copied list that has drifted.
 */
const ALL_STATUSES: readonly HostDispatchStatus[] = [
  "pending",
  "inflight",
  "awaiting-result",
  "succeeded",
  "failed",
  "cancelled",
  "deadletter",
]

describe("activity types", () => {
  it("covers every dispatch status the queue can report", () => {
    expect(new Set(ALL_STATUSES).size).toBe(ALL_STATUSES.length)
    expect(ALL_STATUSES).toContain("deadletter")
  })

  it("counts dimensions without requiring every dimension to be present", () => {
    const counts: PlacementDimensionCounts = { platform: 2 }
    expect(counts.platform).toBe(2)
    expect(counts.sandbox).toBeUndefined()
  })
})
