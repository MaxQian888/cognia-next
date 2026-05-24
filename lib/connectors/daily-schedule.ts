/**
 * Generic daily-housekeeping scheduler for connector background sweeps.
 *
 * Extracted so cross-adapter cleanup tasks (attachment cache eviction, and
 * any future periodic prune) share one timer mechanism instead of each
 * re-implementing the setTimeout → setInterval handoff. The first run fires
 * after `initialDelayMs` (so it doesn't compete with app boot); subsequent
 * runs fire every `intervalMs`. Errors thrown by the task are caught and
 * logged so a single failure never kills the schedule.
 *
 * `startCallbackBindingCleanupSchedule` predates this and keeps its own
 * equivalent loop; it is intentionally left untouched.
 */

/** Interval between sweeps. 24 h matches the OS-scheduler conventions used elsewhere. */
export const DAILY_INTERVAL_MS = 24 * 60 * 60 * 1000

/** Default delay before the first sweep, so we don't compete with app boot. */
export const DAILY_INITIAL_DELAY_MS = 60 * 1000

export interface DailyScheduleHandle {
  /** Stop the schedule. Idempotent. */
  dispose(): void
  /** Force a run right now (skips the wait). Resolves when the task settles. */
  runNow(): Promise<void>
}

export interface DailyScheduleOptions {
  /** The work to run on each tick. */
  task: () => Promise<void>
  /** Label used in error logs. */
  label: string
  /** Override the interval (tests use a small value). Defaults to 24 h. */
  intervalMs?: number
  /** Override the initial delay (tests use 0). Defaults to 60 s. */
  initialDelayMs?: number
  /** Override the timer scheduler (tests). */
  scheduler?: {
    setTimeout: (cb: () => void, ms: number) => unknown
    clearTimeout: (handle: unknown) => void
    setInterval: (cb: () => void, ms: number) => unknown
    clearInterval: (handle: unknown) => void
  }
}

/**
 * Start a daily schedule. Returns a handle the caller MUST dispose on
 * teardown so the timers don't leak.
 */
export function startDailySchedule(options: DailyScheduleOptions): DailyScheduleHandle {
  const {
    task,
    label,
    intervalMs = DAILY_INTERVAL_MS,
    initialDelayMs = DAILY_INITIAL_DELAY_MS,
    scheduler = {
      setTimeout: (cb, ms) => setTimeout(cb, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      setInterval: (cb, ms) => setInterval(cb, ms),
      clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
    },
  } = options

  let disposed = false
  let initialHandle: unknown = null
  let intervalHandle: unknown = null

  const run = async (): Promise<void> => {
    try {
      await task()
    } catch (err) {
      console.error(`[${label}] sweep failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  initialHandle = scheduler.setTimeout(() => {
    if (disposed) return
    void run()
    intervalHandle = scheduler.setInterval(() => {
      if (disposed) return
      void run()
    }, intervalMs)
  }, initialDelayMs)

  return {
    dispose() {
      if (disposed) return
      disposed = true
      if (initialHandle !== null) scheduler.clearTimeout(initialHandle)
      if (intervalHandle !== null) scheduler.clearInterval(intervalHandle)
    },
    async runNow(): Promise<void> {
      await run()
    },
  }
}
