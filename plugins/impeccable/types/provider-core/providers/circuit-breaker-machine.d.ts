import {
  CircuitBreakerState,
  CircuitBreakerConfig,
  CircuitBreakerStateValue,
} from "@cognia/provider-types/circuit-breaker"

/**
 * Pure circuit-breaker state machine for provider fault tolerance.
 *
 * The state SHAPE + config live in `types/provider/circuit-breaker.ts`; this is
 * the transition logic the store (and the routing engine, via the store) drives.
 * Kept pure (clock injected) so it unit-tests deterministically.
 *
 * Lifecycle:
 *   closed  --(failureThreshold failures in window)-->  open
 *   closed  --(failure RATE >= threshold @ min volume)-->  open   (opt-in)
 *   open    --(cooldownMs | Retry-After cooldown elapsed)-->  half-open  (probing)
 *   half-open --(success)--> closed (after successThreshold) | --(failure)--> open
 *
 * Behavior is byte-identical to the historical absolute-count machine until
 * `failureRateThreshold` is configured or a `retryAfterMs` hint is supplied.
 */

/** Per-failure options (Retry-After hint from the provider error). */
interface RecordFailureOptions {
  retryAfterMs?: number
}
/**
 * The effective state right now: an `open` breaker whose cooldown has elapsed is
 * reported as `half-open` so the next request is allowed through as a probe.
 */
declare function currentStateValue(
  state: CircuitBreakerState,
  config: CircuitBreakerConfig,
  now: number
): CircuitBreakerStateValue
declare function recordSuccess(
  state: CircuitBreakerState,
  config: CircuitBreakerConfig,
  now: number
): CircuitBreakerState
declare function recordFailure(
  state: CircuitBreakerState,
  config: CircuitBreakerConfig,
  now: number,
  opts?: RecordFailureOptions
): CircuitBreakerState

export { type RecordFailureOptions, currentStateValue, recordFailure, recordSuccess }
