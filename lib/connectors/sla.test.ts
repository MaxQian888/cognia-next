import { computeDueAt, isOverdue } from "./sla"

// 2026-06-10T08:00:00Z baseline for deterministic math.
const BASE = Date.UTC(2026, 5, 10, 8, 0, 0)

describe("computeDueAt", () => {
  it("adds the target minutes when no quiet hours apply", () => {
    expect(computeDueAt(BASE, 30)).toBe(BASE + 30 * 60_000)
    expect(computeDueAt(BASE, 0)).toBe(BASE)
  })

  it("treats negative target minutes as zero", () => {
    expect(computeDueAt(BASE, -5)).toBe(BASE)
  })

  it("does not shift a deadline that lands outside the quiet window", () => {
    // Quiet 00:00–06:00 UTC; an 08:30 deadline is well outside.
    const due = computeDueAt(BASE, 30, { from: "00:00", to: "06:00", tz: "UTC" })
    expect(due).toBe(BASE + 30 * 60_000)
  })

  it("pushes a deadline that lands inside the quiet window to the window end", () => {
    // 22:00 UTC start; quiet 21:00–23:00 UTC → +30min lands at 22:30 (quiet) →
    // bumped to 23:00 UTC.
    const start = Date.UTC(2026, 5, 10, 22, 0, 0)
    const due = computeDueAt(start, 30, { from: "21:00", to: "23:00", tz: "UTC" })
    expect(due).toBe(Date.UTC(2026, 5, 10, 23, 0, 0))
  })
})

describe("isOverdue", () => {
  it("is false when there is no row or no due time", () => {
    expect(isOverdue(undefined, BASE)).toBe(false)
    expect(isOverdue({ status: "open" }, BASE)).toBe(false)
  })

  it("is true when the next-response due time is in the past and not resolved", () => {
    expect(isOverdue({ nextResponseDueAt: BASE - 1, status: "open" }, BASE)).toBe(true)
    expect(isOverdue({ nextResponseDueAt: BASE - 1, status: "pending" }, BASE)).toBe(true)
  })

  it("is false at exactly the due time and false once resolved", () => {
    expect(isOverdue({ nextResponseDueAt: BASE, status: "open" }, BASE)).toBe(false)
    expect(isOverdue({ nextResponseDueAt: BASE - 10_000, status: "resolved" }, BASE)).toBe(false)
  })
})
