/**
 * @jest-environment node
 */

import { deriveJobBadge } from "./derive-job-badge"
import type { AdapterInstanceRow, OutboundJobRow } from "@/lib/db/connector-types"

function makeJob(status: OutboundJobRow["status"]): Pick<OutboundJobRow, "status"> {
  return { status }
}

function makeAdapter(
  overrides: Partial<Pick<AdapterInstanceRow, "muted" | "quietHours">> = {}
): Pick<AdapterInstanceRow, "muted" | "quietHours"> {
  return { muted: false, quietHours: undefined, ...overrides }
}

describe("deriveJobBadge — terminal job states keep the normal badge", () => {
  const cases: Array<OutboundJobRow["status"]> = ["sent", "failed", "deadlettered"]
  for (const status of cases) {
    it(`returns normal for status="${status}" even when the breaker is open`, () => {
      const badge = deriveJobBadge({
        job: makeJob(status),
        adapter: makeAdapter({ muted: true }),
        breakerState: "open",
        now: 0,
      })
      expect(badge.kind).toBe("normal")
      expect(badge.reason).toBeNull()
    })
  }
})

describe("deriveJobBadge — circuit breaker takes priority", () => {
  it("returns circuit-blocked when the breaker is open, even if the adapter is also muted", () => {
    const badge = deriveJobBadge({
      job: makeJob("pending"),
      adapter: makeAdapter({ muted: true }),
      breakerState: "open",
      now: 0,
    })
    expect(badge.kind).toBe("circuit-blocked")
    expect(badge.reason).toBe("circuit_open")
    expect(badge.etaMs).toBeNull()
  })

  it("ignores half_open as a non-blocking state", () => {
    const badge = deriveJobBadge({
      job: makeJob("pending"),
      adapter: makeAdapter(),
      breakerState: "half_open",
      now: 0,
    })
    expect(badge.kind).toBe("normal")
  })

  it("ignores null breakerState (no runtime data yet)", () => {
    const badge = deriveJobBadge({
      job: makeJob("pending"),
      adapter: makeAdapter(),
      breakerState: null,
      now: 0,
    })
    expect(badge.kind).toBe("normal")
  })
})

describe("deriveJobBadge — muted switch", () => {
  it("returns paused-muted when adapter.muted is true", () => {
    const badge = deriveJobBadge({
      job: makeJob("pending"),
      adapter: makeAdapter({ muted: true }),
      breakerState: "closed",
      now: 0,
    })
    expect(badge.kind).toBe("paused-muted")
    expect(badge.reason).toBe("muted")
    expect(badge.etaMs).toBeNull()
  })

  it("dominates quiet hours when both are active", () => {
    const badge = deriveJobBadge({
      job: makeJob("pending"),
      adapter: makeAdapter({
        muted: true,
        quietHours: { from: "00:00", to: "23:59", tz: "UTC" },
      }),
      breakerState: "closed",
      now: Date.UTC(2026, 0, 1, 12, 0, 0),
    })
    expect(badge.kind).toBe("paused-muted")
  })
})

describe("deriveJobBadge — quiet hours", () => {
  it("returns paused-quiet-hours with etaMs when within the window", () => {
    // 14:00 UTC, window 09:00–17:00 → 3 hours = 10_800_000 ms until window end
    const now = Date.UTC(2026, 0, 1, 14, 0, 0)
    const badge = deriveJobBadge({
      job: makeJob("pending"),
      adapter: makeAdapter({ quietHours: { from: "09:00", to: "17:00", tz: "UTC" } }),
      breakerState: "closed",
      now,
    })
    expect(badge.kind).toBe("paused-quiet-hours")
    expect(badge.reason).toBe("quiet_hours")
    // Allow a small range — msUntilQuietEnd rounds to whole seconds.
    expect(badge.etaMs).toBeGreaterThan(10_700_000)
    expect(badge.etaMs).toBeLessThan(10_900_000)
  })

  it("returns normal when the current time is outside the window", () => {
    // 20:00 UTC, window 09:00–17:00 — window is closed.
    const now = Date.UTC(2026, 0, 1, 20, 0, 0)
    const badge = deriveJobBadge({
      job: makeJob("pending"),
      adapter: makeAdapter({ quietHours: { from: "09:00", to: "17:00", tz: "UTC" } }),
      breakerState: "closed",
      now,
    })
    expect(badge.kind).toBe("normal")
  })

  it("handles cross-midnight windows correctly", () => {
    // 04:00 UTC, window 22:00–06:00 — currently inside.
    const now = Date.UTC(2026, 0, 1, 4, 0, 0)
    const badge = deriveJobBadge({
      job: makeJob("pending"),
      adapter: makeAdapter({ quietHours: { from: "22:00", to: "06:00", tz: "UTC" } }),
      breakerState: "closed",
      now,
    })
    expect(badge.kind).toBe("paused-quiet-hours")
    expect(badge.etaMs).toBeGreaterThan(0)
  })

  it("ignores incomplete quiet-hours rows (missing tz)", () => {
    const badge = deriveJobBadge({
      job: makeJob("pending"),
      adapter: makeAdapter({
        quietHours: { from: "09:00", to: "17:00", tz: "" },
      }),
      breakerState: "closed",
      now: Date.UTC(2026, 0, 1, 14, 0, 0),
    })
    expect(badge.kind).toBe("normal")
  })
})

describe("deriveJobBadge — null / missing adapter row", () => {
  it("returns normal when adapter is null", () => {
    const badge = deriveJobBadge({
      job: makeJob("pending"),
      adapter: null,
      breakerState: "closed",
      now: 0,
    })
    expect(badge.kind).toBe("normal")
  })

  it("returns normal when adapter is undefined", () => {
    const badge = deriveJobBadge({
      job: makeJob("pending"),
      adapter: undefined,
      breakerState: "closed",
      now: 0,
    })
    expect(badge.kind).toBe("normal")
  })

  it("still surfaces circuit-blocked even when adapter is null", () => {
    const badge = deriveJobBadge({
      job: makeJob("pending"),
      adapter: null,
      breakerState: "open",
      now: 0,
    })
    expect(badge.kind).toBe("circuit-blocked")
  })
})
