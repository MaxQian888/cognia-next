import { computeBackupHealth } from "./backup-health"

const NOW = 1_700_000_000_000
const DAY = 24 * 60 * 60 * 1000

describe("computeBackupHealth", () => {
  it('returns "never" with null lastSuccessAt when there is no history', () => {
    expect(computeBackupHealth({ now: NOW })).toEqual({ status: "never", lastSuccessAt: null })
  })

  it('returns "ok" when the last success is within the reminder window', () => {
    const completedAt = NOW - 1 * DAY
    expect(
      computeBackupHealth({
        latestSuccess: { completedAt },
        latestAttempt: { success: true, completedAt },
        reminderDays: 7,
        now: NOW,
      })
    ).toEqual({ status: "ok", lastSuccessAt: completedAt })
  })

  it('returns "stale" when the last success is past the reminder window', () => {
    const completedAt = NOW - 10 * DAY
    expect(
      computeBackupHealth({
        latestSuccess: { completedAt },
        latestAttempt: { success: true, completedAt },
        reminderDays: 7,
        now: NOW,
      })
    ).toEqual({ status: "stale", lastSuccessAt: completedAt })
  })

  it('returns "failed" when the newest attempt failed, still reporting the older success', () => {
    const successAt = NOW - 3 * DAY
    const failedAt = NOW - 1 * DAY
    expect(
      computeBackupHealth({
        latestSuccess: { completedAt: successAt },
        latestAttempt: { success: false, completedAt: failedAt },
        reminderDays: 7,
        now: NOW,
      })
    ).toEqual({ status: "failed", lastSuccessAt: successAt })
  })

  it('"failed" beats "stale" — a failed attempt over an old success', () => {
    const successAt = NOW - 30 * DAY
    const failedAt = NOW - 2 * DAY
    expect(
      computeBackupHealth({
        latestSuccess: { completedAt: successAt },
        latestAttempt: { success: false, completedAt: failedAt },
        reminderDays: 7,
        now: NOW,
      }).status
    ).toBe("failed")
  })

  it('"failed" with no prior success reports null lastSuccessAt', () => {
    expect(
      computeBackupHealth({
        latestAttempt: { success: false, completedAt: NOW - DAY },
        reminderDays: 7,
        now: NOW,
      })
    ).toEqual({ status: "failed", lastSuccessAt: null })
  })

  it('returns "ok" (not stale) when reminderDays is undefined — staleness opt-out', () => {
    const completedAt = NOW - 100 * DAY
    expect(
      computeBackupHealth({
        latestSuccess: { completedAt },
        latestAttempt: { success: true, completedAt },
        now: NOW,
      })
    ).toEqual({ status: "ok", lastSuccessAt: completedAt })
  })
})
