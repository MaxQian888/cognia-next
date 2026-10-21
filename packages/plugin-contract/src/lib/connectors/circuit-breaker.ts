/**
 * The plugin contract's share of `lib/connectors/circuit-breaker.ts`, which re-exports these.
 */
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
