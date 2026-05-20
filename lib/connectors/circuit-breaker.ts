/**
 * Per-adapter sliding-window circuit breaker — Task 38.
 *
 * States:
 *   closed    → normal; tracks recent failures in a rolling window.
 *   open      → tripped; all requests rejected until cooldownMs elapses.
 *   half_open → cooldown elapsed; allows exactly one probe. Consecutive
 *               successes (`closeOnSuccessCount`) close the breaker; any
 *               failure re-opens it.
 *
 * Sliding window:
 *   Within the last `windowMs`, track every recordSuccess / recordFailure
 *   call. When the failure rate among the most recent `minEvents` exceeds
 *   `failureThresholdPct` the breaker opens.
 */

export interface CircuitBreakerOptions {
  /** Window for sliding-window failure rate calculation (ms). Default 30 000. */
  windowMs: number
  /** Minimum events within window before the threshold is evaluated. Default 5. */
  minEvents: number
  /** Percentage of failures (0-100) that trips the breaker. Default 50. */
  failureThresholdPct: number
  /** Time the breaker stays open before moving to half-open (ms). Default 30 000. */
  cooldownMs: number
  /** Consecutive successes in half-open state needed to close. Default 3. */
  closeOnSuccessCount: number
  /** Clock injection for tests. Defaults to `() => Date.now()`. */
  now?: () => number
}

const DEFAULTS: Required<Omit<CircuitBreakerOptions, "now">> = {
  windowMs: 30_000,
  minEvents: 5,
  failureThresholdPct: 50,
  cooldownMs: 30_000,
  closeOnSuccessCount: 3,
}

export type CircuitState = "closed" | "open" | "half_open"

/**
 * Inspectable snapshot of the breaker's internal state — added so the
 * heartbeat probe can write circuit metadata into the audit log and the
 * Health Detail panel can render it without holding a reference to the
 * breaker itself.
 */
export interface CircuitBreakerSnapshot {
  state: CircuitState
  /** Wall-clock ms at which the breaker opened. `null` when closed. */
  openedAt: number | null
  /** Consecutive successes accumulated while half-open. */
  halfOpenSuccesses: number
  /** Failure rate (0–100) over the current sliding window. */
  recentFailureRate: number
  /** Number of events currently in the sliding window. */
  eventCount: number
}

export interface CircuitBreaker {
  recordSuccess(): void
  recordFailure(): void
  state(): CircuitState
  /** Returns true when the caller is allowed to attempt a request. */
  canPass(): boolean
  /**
   * Take an inspectable snapshot of the breaker's internal state. Pure
   * read — does not advance the sliding window or transition states.
   */
  snapshot(): CircuitBreakerSnapshot
}

interface EventRecord {
  at: number
  success: boolean
}

export function createCircuitBreaker(opts?: Partial<CircuitBreakerOptions>): CircuitBreaker {
  const cfg: Required<Omit<CircuitBreakerOptions, "now">> = { ...DEFAULTS, ...opts }
  const clock = opts?.now ?? (() => Date.now())

  const events: EventRecord[] = []
  let _state: CircuitState = "closed"
  let openedAt: number | null = null
  let halfOpenSuccesses = 0

  function pruneWindow(now: number): void {
    const cutoff = now - cfg.windowMs
    // Remove events older than the window
    while (events.length > 0 && events[0].at < cutoff) {
      events.shift()
    }
  }

  function evaluateThreshold(now: number): void {
    if (_state !== "closed") return
    pruneWindow(now)
    if (events.length < cfg.minEvents) return
    const failures = events.filter((e) => !e.success).length
    const rate = (failures / events.length) * 100
    if (rate >= cfg.failureThresholdPct) {
      _state = "open"
      openedAt = now
    }
  }

  return {
    recordSuccess(): void {
      const now = clock()
      events.push({ at: now, success: true })
      if (_state === "half_open") {
        halfOpenSuccesses++
        if (halfOpenSuccesses >= cfg.closeOnSuccessCount) {
          _state = "closed"
          halfOpenSuccesses = 0
          openedAt = null
          events.length = 0 // reset window after recovery
        }
      } else {
        evaluateThreshold(now)
      }
    },

    recordFailure(): void {
      const now = clock()
      events.push({ at: now, success: false })
      if (_state === "half_open") {
        // Re-open immediately on half-open failure
        _state = "open"
        openedAt = now
        halfOpenSuccesses = 0
      } else {
        evaluateThreshold(now)
      }
    },

    state(): CircuitState {
      if (_state === "open") {
        const now = clock()
        if (openedAt !== null && now - openedAt >= cfg.cooldownMs) {
          _state = "half_open"
          halfOpenSuccesses = 0
        }
      }
      return _state
    },

    canPass(): boolean {
      const s = this.state()
      return s === "closed" || s === "half_open"
    },

    snapshot(): CircuitBreakerSnapshot {
      // Make sure a cooldown-driven half-open transition is reflected first.
      const liveState = this.state()
      const now = clock()
      pruneWindow(now)
      const eventCount = events.length
      const failures = eventCount === 0 ? 0 : events.filter((e) => !e.success).length
      const recentFailureRate = eventCount === 0 ? 0 : (failures / eventCount) * 100
      return {
        state: liveState,
        openedAt: liveState === "closed" ? null : openedAt,
        halfOpenSuccesses,
        recentFailureRate,
        eventCount,
      }
    },
  }
}
