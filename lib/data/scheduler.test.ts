// Pure-function tests for the scheduling and reminder helpers.

import { shouldRunScheduledBackup, shouldShowReminder, pruneScheduledBackups } from "./scheduler"
import { DEFAULT_BACKUP_AUTO_SCHEDULE } from "@/lib/claude/types"

const DAY = 24 * 60 * 60 * 1000

describe("shouldRunScheduledBackup", () => {
  it("returns false when config is missing or disabled", () => {
    expect(shouldRunScheduledBackup({ config: undefined, lastSuccessAt: undefined })).toBe(false)
    expect(
      shouldRunScheduledBackup({
        config: { enabled: false, intervalDays: 7, retainCount: 5 },
        lastSuccessAt: undefined,
      })
    ).toBe(false)
  })

  it("returns true on first run (no prior success)", () => {
    expect(
      shouldRunScheduledBackup({
        config: { ...DEFAULT_BACKUP_AUTO_SCHEDULE, enabled: true },
        lastSuccessAt: undefined,
      })
    ).toBe(true)
  })

  it("returns false until the interval has elapsed", () => {
    const now = 1_000_000_000
    expect(
      shouldRunScheduledBackup({
        config: { ...DEFAULT_BACKUP_AUTO_SCHEDULE, enabled: true, intervalDays: 7 },
        lastSuccessAt: now - 6 * DAY,
        now,
      })
    ).toBe(false)
    expect(
      shouldRunScheduledBackup({
        config: { ...DEFAULT_BACKUP_AUTO_SCHEDULE, enabled: true, intervalDays: 7 },
        lastSuccessAt: now - 7 * DAY,
        now,
      })
    ).toBe(true)
  })

  it("treats intervalDays <= 0 as disabled", () => {
    expect(
      shouldRunScheduledBackup({
        config: { ...DEFAULT_BACKUP_AUTO_SCHEDULE, enabled: true, intervalDays: 0 },
        lastSuccessAt: undefined,
      })
    ).toBe(false)
  })
})

describe("shouldShowReminder", () => {
  const now = 1_000_000_000
  it("returns false when reminderDays is unset or zero", () => {
    expect(
      shouldShowReminder({
        reminderDays: undefined,
        lastSuccessAt: undefined,
        dismissedAt: undefined,
        now,
      })
    ).toBe(false)
    expect(
      shouldShowReminder({
        reminderDays: 0,
        lastSuccessAt: undefined,
        dismissedAt: undefined,
        now,
      })
    ).toBe(false)
  })

  it("returns false when last success is recent", () => {
    expect(
      shouldShowReminder({
        reminderDays: 7,
        lastSuccessAt: now - 3 * DAY,
        dismissedAt: undefined,
        now,
      })
    ).toBe(false)
  })

  it("returns true when last success is older than the window", () => {
    expect(
      shouldShowReminder({
        reminderDays: 7,
        lastSuccessAt: now - 8 * DAY,
        dismissedAt: undefined,
        now,
      })
    ).toBe(true)
  })

  it("respects a recent dismissal", () => {
    expect(
      shouldShowReminder({
        reminderDays: 7,
        lastSuccessAt: now - 30 * DAY,
        dismissedAt: now - DAY,
        now,
      })
    ).toBe(false)
    expect(
      shouldShowReminder({
        reminderDays: 7,
        lastSuccessAt: now - 30 * DAY,
        dismissedAt: now - 8 * DAY,
        now,
      })
    ).toBe(true)
  })
})

describe("pruneScheduledBackups", () => {
  const candidates = [
    { name: "a", completedAt: 1 },
    { name: "b", completedAt: 5 },
    { name: "c", completedAt: 3 },
    { name: "d", completedAt: 4 },
  ]

  it("returns an empty list when the count is at or below the cap", () => {
    expect(pruneScheduledBackups(candidates, 4)).toEqual([])
    expect(pruneScheduledBackups(candidates, 10)).toEqual([])
  })

  it("returns the oldest candidates when over the cap", () => {
    const out = pruneScheduledBackups(candidates, 2).map((c) => c.name)
    expect(out.sort()).toEqual(["a", "c"])
  })

  it("treats retainCount<=0 as 'delete all'", () => {
    expect(pruneScheduledBackups(candidates, 0)).toHaveLength(4)
    expect(pruneScheduledBackups(candidates, -1)).toHaveLength(4)
  })
})
