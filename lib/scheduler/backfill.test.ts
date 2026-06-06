/**
 * Tests for backfill slot enumeration (pure module). Uses the real
 * cron-parser so cron slot math is verified end-to-end.
 */

import type { ScheduledTask } from "@/types/scheduler"

import { BACKFILL_MAX_SLOTS, enumerateBackfillSlots } from "./backfill"

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: "bf-task",
    name: "Backfill Task",
    type: "custom",
    trigger: { type: "cron", cronExpression: "0 * * * *", timezone: "UTC" },
    config: {
      timeout: 1000,
      maxRetries: 0,
      retryDelay: 100,
      runMissedOnStartup: false,
    },
    notification: { onStart: false, onComplete: false, onError: false },
    status: "active",
    runCount: 0,
    successCount: 0,
    failureCount: 0,
    createdAt: new Date("2026-06-01T00:00:00Z"),
    updatedAt: new Date("2026-06-01T00:00:00Z"),
    ...overrides,
  }
}

describe("enumerateBackfillSlots", () => {
  it("enumerates hourly cron slots inside the range, inclusive of boundaries", () => {
    const slots = enumerateBackfillSlots(
      makeTask(),
      new Date("2026-06-05T01:00:00Z"),
      new Date("2026-06-05T03:00:00Z")
    )

    expect(slots.map((d) => d.toISOString())).toEqual([
      "2026-06-05T01:00:00.000Z",
      "2026-06-05T02:00:00.000Z",
      "2026-06-05T03:00:00.000Z",
    ])
  })

  it("returns oldest-first ordering", () => {
    const slots = enumerateBackfillSlots(
      makeTask(),
      new Date("2026-06-05T00:00:00Z"),
      new Date("2026-06-05T05:00:00Z")
    )
    for (let i = 1; i < slots.length; i++) {
      expect(slots[i].getTime()).toBeGreaterThan(slots[i - 1].getTime())
    }
    expect(slots).toHaveLength(6)
  })

  it("caps cron enumeration at maxSlots", () => {
    const slots = enumerateBackfillSlots(
      makeTask({ trigger: { type: "cron", cronExpression: "* * * * *", timezone: "UTC" } }),
      new Date("2026-06-01T00:00:00Z"),
      new Date("2026-06-05T00:00:00Z"),
      10
    )
    expect(slots).toHaveLength(10)
  })

  it("enumerates interval slots phase-anchored on createdAt", () => {
    const task = makeTask({
      trigger: { type: "interval", intervalMs: 3_600_000 }, // hourly
      createdAt: new Date("2026-06-01T00:30:00Z"),
    })

    const slots = enumerateBackfillSlots(
      task,
      new Date("2026-06-01T01:00:00Z"),
      new Date("2026-06-01T04:00:00Z")
    )

    // Slots are createdAt + k*interval: 01:30, 02:30, 03:30.
    expect(slots.map((d) => d.toISOString())).toEqual([
      "2026-06-01T01:30:00.000Z",
      "2026-06-01T02:30:00.000Z",
      "2026-06-01T03:30:00.000Z",
    ])
  })

  it("excludes the interval base itself (first slot is base + interval)", () => {
    const task = makeTask({
      trigger: { type: "interval", intervalMs: 60_000 },
      createdAt: new Date("2026-06-01T00:00:00Z"),
    })

    const slots = enumerateBackfillSlots(
      task,
      new Date("2026-06-01T00:00:00Z"),
      new Date("2026-06-01T00:02:00Z")
    )

    expect(slots.map((d) => d.toISOString())).toEqual([
      "2026-06-01T00:01:00.000Z",
      "2026-06-01T00:02:00.000Z",
    ])
  })

  it("caps interval enumeration at the default maximum", () => {
    const task = makeTask({
      trigger: { type: "interval", intervalMs: 1_000 },
      createdAt: new Date("2026-06-01T00:00:00Z"),
    })

    const slots = enumerateBackfillSlots(
      task,
      new Date("2026-06-01T00:00:00Z"),
      new Date("2026-06-01T01:00:00Z") // 3600 candidate slots
    )

    expect(slots).toHaveLength(BACKFILL_MAX_SLOTS)
  })

  it("returns empty for once and event triggers", () => {
    const start = new Date("2026-06-01T00:00:00Z")
    const end = new Date("2026-06-05T00:00:00Z")
    expect(
      enumerateBackfillSlots(
        makeTask({ trigger: { type: "once", runAt: new Date("2026-06-02T00:00:00Z") } }),
        start,
        end
      )
    ).toEqual([])
    expect(
      enumerateBackfillSlots(
        makeTask({ trigger: { type: "event", eventType: "custom" } }),
        start,
        end
      )
    ).toEqual([])
  })

  it("returns empty when end precedes start or maxSlots is non-positive", () => {
    expect(
      enumerateBackfillSlots(
        makeTask(),
        new Date("2026-06-05T00:00:00Z"),
        new Date("2026-06-01T00:00:00Z")
      )
    ).toEqual([])
    expect(
      enumerateBackfillSlots(
        makeTask(),
        new Date("2026-06-01T00:00:00Z"),
        new Date("2026-06-05T00:00:00Z"),
        0
      )
    ).toEqual([])
  })

  it("respects the cron timezone", () => {
    // 09:00 daily in Asia/Shanghai = 01:00 UTC.
    const slots = enumerateBackfillSlots(
      makeTask({
        trigger: { type: "cron", cronExpression: "0 9 * * *", timezone: "Asia/Shanghai" },
      }),
      new Date("2026-06-01T00:00:00Z"),
      new Date("2026-06-03T00:00:00Z")
    )

    expect(slots.map((d) => d.toISOString())).toEqual([
      "2026-06-01T01:00:00.000Z",
      "2026-06-02T01:00:00.000Z",
    ])
  })
})
