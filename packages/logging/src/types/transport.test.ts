import {
  LOG_DROP_REASONS,
  dropCountsSumTo,
  recordDrop,
  totalDrops,
  type LogDropCounts,
  type TransportHealthSnapshot,
} from "./transport"

const snapshot = (over: Partial<TransportHealthSnapshot> = {}): TransportHealthSnapshot => ({
  transport: "t",
  status: "healthy",
  queueDepth: 0,
  retryCount: 0,
  droppedEntries: 0,
  updatedAt: "",
  ...over,
})

describe("drop reasons", () => {
  it("is a closed, non-empty set", () => {
    expect(LOG_DROP_REASONS.length).toBeGreaterThan(0)
    expect(new Set(LOG_DROP_REASONS).size).toBe(LOG_DROP_REASONS.length)
  })

  it("names the four ways a transport actually loses data, plus retention", () => {
    expect([...LOG_DROP_REASONS].sort()).toEqual([
      "entry-rejected",
      "overflow-evicted",
      "retention-pruned",
      "ship-failed",
      "shutdown-discarded",
    ])
  })
})

describe("recordDrop", () => {
  it("accumulates per reason", () => {
    const counts: LogDropCounts = {}
    recordDrop(counts, "ship-failed", 3)
    recordDrop(counts, "ship-failed", 2)
    recordDrop(counts, "overflow-evicted")
    expect(counts).toEqual({ "ship-failed": 5, "overflow-evicted": 1 })
  })

  it("ignores a non-positive or non-finite count rather than corrupting the total", () => {
    const counts: LogDropCounts = {}
    recordDrop(counts, "ship-failed", 0)
    recordDrop(counts, "ship-failed", -4)
    recordDrop(counts, "ship-failed", Number.NaN)
    expect(counts).toEqual({})
  })
})

describe("totalDrops", () => {
  it("sums every reason", () => {
    expect(totalDrops({ "ship-failed": 2, "entry-rejected": 3 })).toBe(5)
  })

  it("is zero for nothing", () => {
    expect(totalDrops(undefined)).toBe(0)
    expect(totalDrops({})).toBe(0)
  })
})

describe("dropCountsSumTo", () => {
  it("holds when every loss is attributed", () => {
    expect(
      dropCountsSumTo(snapshot({ droppedEntries: 4, droppedByReason: { "ship-failed": 4 } }))
    ).toBe(true)
  })

  it("fails when some loss is unexplained — the case worth noticing", () => {
    expect(
      dropCountsSumTo(snapshot({ droppedEntries: 9, droppedByReason: { "ship-failed": 4 } }))
    ).toBe(false)
    expect(dropCountsSumTo(snapshot({ droppedEntries: 1 }))).toBe(false)
  })

  it("holds trivially when nothing was lost", () => {
    expect(dropCountsSumTo(snapshot())).toBe(true)
  })
})
