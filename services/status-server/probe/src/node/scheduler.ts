/**
 * UTC-minute scheduler (plan §4, §5).
 *
 * Runs fire at minute boundaries and carry that boundary as `scheduledAt`,
 * which is what the server slots on. A profile's check class is due when the
 * minute's epoch seconds divide by its cadence, so a 300 s profile runs at
 * :00, :05, ... on every host. A profile never overlaps itself: if the
 * previous run is still going, this minute is skipped and logged as an
 * observer gap — nothing is submitted for it, so it is never mistaken for a
 * service failure.
 */

import { MINUTE_MS } from "../../../../../lib/status/contract"

import type { ProfileConfig } from "./config"

export interface DueChecks {
  runHttp: boolean
  runProtocol: boolean
}

export function dueChecks(minuteMs: number, profile: ProfileConfig): DueChecks {
  const seconds = Math.floor(minuteMs / 1_000)
  const due = (cadence: number | null) => cadence !== null && seconds % cadence === 0
  return {
    runHttp: due(profile.httpCadenceSeconds),
    runProtocol: due(profile.protocolCadenceSeconds),
  }
}

export interface MinuteSchedulerOptions {
  profiles: ProfileConfig[]
  onRun: (profile: ProfileConfig, scheduledAtMs: number, due: DueChecks) => Promise<void>
  onSkip: (profile: ProfileConfig, scheduledAtMs: number) => void
  /** Minutes the timer missed entirely (process suspended, clock jump). */
  onMissed?: (fromMs: number, count: number) => void
  now?: () => number
}

export class MinuteScheduler {
  private readonly inFlight = new Map<string, Promise<void>>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = true
  private nextBoundaryMs = 0
  private readonly now: () => number

  constructor(private readonly options: MinuteSchedulerOptions) {
    this.now = options.now ?? Date.now
  }

  /** Start ticking at the next UTC minute boundary. */
  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.nextBoundaryMs = (Math.floor(this.now() / MINUTE_MS) + 1) * MINUTE_MS
    this.arm()
  }

  /** Stop scheduling. In-flight runs are left to the caller to abort. */
  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** Settles once every in-flight run has finished. */
  async idle(): Promise<void> {
    await Promise.allSettled([...this.inFlight.values()])
  }

  get running(): string[] {
    return [...this.inFlight.keys()]
  }

  /** Dispatch every profile due at `minuteMs` (exposed for tests). */
  tick(minuteMs: number): void {
    for (const profile of this.options.profiles) {
      const due = dueChecks(minuteMs, profile)
      if (!due.runHttp && !due.runProtocol) continue
      if (this.inFlight.has(profile.id)) {
        this.options.onSkip(profile, minuteMs)
        continue
      }
      const run = this.options
        .onRun(profile, minuteMs, due)
        .catch(() => undefined)
        .finally(() => {
          if (this.inFlight.get(profile.id) === run) this.inFlight.delete(profile.id)
        })
      this.inFlight.set(profile.id, run)
    }
  }

  private arm(): void {
    if (this.stopped) return
    const delay = Math.max(0, this.nextBoundaryMs - this.now())
    this.timer = setTimeout(() => this.fire(), delay)
  }

  private fire(): void {
    if (this.stopped) return
    const now = this.now()
    // Timers can fire a hair early; never run a minute before it starts.
    if (now < this.nextBoundaryMs) {
      this.arm()
      return
    }
    const currentMinute = Math.floor(now / MINUTE_MS) * MINUTE_MS
    if (currentMinute > this.nextBoundaryMs) {
      // Missed boundaries are gaps; do not run them late as if on time.
      this.options.onMissed?.(
        this.nextBoundaryMs,
        (currentMinute - this.nextBoundaryMs) / MINUTE_MS
      )
    }
    this.tick(currentMinute)
    this.nextBoundaryMs = currentMinute + MINUTE_MS
    this.arm()
  }
}
