/**
 * Tests for the pure runtime-policy helpers (overlap policy resolution,
 * jitter, lifecycle limits, catch-up window).
 */

import type { ScheduledTask, TaskExecutionConfig } from "@/types/scheduler"

import {
  applyJitter,
  isAtMaxRuns,
  isPastEndAt,
  isSlotOutsideCatchupWindow,
  resolveOverlapPolicy,
} from "./runtime-policy"

const baseConfig: TaskExecutionConfig = {
  timeout: 1000,
  maxRetries: 0,
  retryDelay: 100,
  runMissedOnStartup: false,
  allowConcurrent: false,
}

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "t1",
    name: "Task",
    type: "custom",
    trigger: { type: "interval", intervalMs: 60_000 },
    config: { ...baseConfig },
    notification: { onStart: false, onComplete: false, onError: false },
    status: "active",
    runCount: 0,
    successCount: 0,
    failureCount: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  }
}

describe("resolveOverlapPolicy", () => {
  it("returns the explicit overlapPolicy when set", () => {
    expect(resolveOverlapPolicy({ ...baseConfig, overlapPolicy: "queue-one" })).toBe("queue-one")
  })

  it("does not let allowConcurrent override an explicit policy", () => {
    expect(
      resolveOverlapPolicy({ ...baseConfig, allowConcurrent: true, overlapPolicy: "skip" })
    ).toBe("skip")
  })

  it("derives 'allow' from legacy allowConcurrent: true", () => {
    expect(resolveOverlapPolicy({ ...baseConfig, allowConcurrent: true })).toBe("allow")
  })

  it("derives 'skip' from legacy allowConcurrent: false", () => {
    expect(resolveOverlapPolicy({ ...baseConfig, allowConcurrent: false })).toBe("skip")
  })

  it("defaults to 'skip' when both fields are absent", () => {
    const config = { ...baseConfig }
    delete (config as Partial<TaskExecutionConfig>).allowConcurrent
    expect(resolveOverlapPolicy(config)).toBe("skip")
  })
})

describe("applyJitter", () => {
  it("returns the base time when jitter is undefined", () => {
    expect(applyJitter(1_000, undefined)).toBe(1_000)
  })

  it("returns the base time when jitter is zero or negative", () => {
    expect(applyJitter(1_000, 0)).toBe(1_000)
    expect(applyJitter(1_000, -500)).toBe(1_000)
  })

  it("adds zero at the low rng extreme", () => {
    expect(applyJitter(1_000, 5_000, () => 0)).toBe(1_000)
  })

  it("adds the full jitter at the high rng extreme", () => {
    expect(applyJitter(1_000, 5_000, () => 0.999999)).toBe(6_000)
  })

  it("adds a proportional offset for mid-range rng", () => {
    expect(applyJitter(1_000, 4_000, () => 0.5)).toBe(3_000)
  })

  it("never exceeds base + jitterMs", () => {
    for (const r of [0, 0.25, 0.5, 0.75, 0.999999]) {
      const armed = applyJitter(10_000, 250, () => r)
      expect(armed).toBeGreaterThanOrEqual(10_000)
      expect(armed).toBeLessThanOrEqual(10_250)
    }
  })
})

describe("isPastEndAt", () => {
  const now = new Date("2026-06-06T12:00:00Z")

  it("is false when endAt is unset", () => {
    expect(isPastEndAt(makeTask(), now)).toBe(false)
  })

  it("is false before endAt", () => {
    expect(isPastEndAt(makeTask({ endAt: new Date("2026-06-07T00:00:00Z") }), now)).toBe(false)
  })

  it("is true at exactly endAt", () => {
    expect(isPastEndAt(makeTask({ endAt: new Date(now) }), now)).toBe(true)
  })

  it("is true after endAt", () => {
    expect(isPastEndAt(makeTask({ endAt: new Date("2026-06-01T00:00:00Z") }), now)).toBe(true)
  })
})

describe("isAtMaxRuns", () => {
  it("is false when maxRuns is unset", () => {
    expect(isAtMaxRuns(makeTask({ runCount: 100 }))).toBe(false)
  })

  it("is false when maxRuns is zero or negative (treated as unlimited)", () => {
    expect(isAtMaxRuns(makeTask({ runCount: 5, config: { ...baseConfig, maxRuns: 0 } }))).toBe(
      false
    )
    expect(isAtMaxRuns(makeTask({ runCount: 5, config: { ...baseConfig, maxRuns: -1 } }))).toBe(
      false
    )
  })

  it("is false below the limit", () => {
    expect(isAtMaxRuns(makeTask({ runCount: 2, config: { ...baseConfig, maxRuns: 3 } }))).toBe(
      false
    )
  })

  it("is true at the limit", () => {
    expect(isAtMaxRuns(makeTask({ runCount: 3, config: { ...baseConfig, maxRuns: 3 } }))).toBe(true)
  })

  it("is true above the limit", () => {
    expect(isAtMaxRuns(makeTask({ runCount: 4, config: { ...baseConfig, maxRuns: 3 } }))).toBe(true)
  })
})

describe("isSlotOutsideCatchupWindow", () => {
  const now = new Date("2026-06-06T12:00:00Z").getTime()

  it("is false when the window is unset", () => {
    expect(isSlotOutsideCatchupWindow(new Date(now - 86_400_000), new Date(now), undefined)).toBe(
      false
    )
  })

  it("is false when the window is zero or negative (unlimited)", () => {
    expect(isSlotOutsideCatchupWindow(new Date(now - 86_400_000), new Date(now), 0)).toBe(false)
    expect(isSlotOutsideCatchupWindow(new Date(now - 86_400_000), new Date(now), -1)).toBe(false)
  })

  it("is false for a slot exactly at the window boundary", () => {
    expect(isSlotOutsideCatchupWindow(new Date(now - 60_000), new Date(now), 60_000)).toBe(false)
  })

  it("is true for a slot older than the window", () => {
    expect(isSlotOutsideCatchupWindow(new Date(now - 60_001), new Date(now), 60_000)).toBe(true)
  })

  it("is false for a fresh slot", () => {
    expect(isSlotOutsideCatchupWindow(new Date(now - 1_000), new Date(now), 60_000)).toBe(false)
  })
})
