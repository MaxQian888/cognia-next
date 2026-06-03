/**
 * Pure circuit-breaker state machine for provider fault tolerance.
 *
 * The state SHAPE + config live in `types/provider/circuit-breaker.ts`; this is
 * the transition logic the store (and the routing engine, via the store) drives.
 * Kept pure (clock injected) so it unit-tests deterministically.
 *
 * Lifecycle:
 *   closed  --(failureThreshold failures in window)-->  open
 *   open    --(cooldownMs elapsed)------------------->  half-open  (probing)
 *   half-open --(success)--> closed (after successThreshold) | --(failure)--> open
 */

import type {
  CircuitBreakerConfig,
  CircuitBreakerState,
  CircuitBreakerStateValue,
} from "@/types/provider/circuit-breaker"

/**
 * The effective state right now: an `open` breaker whose cooldown has elapsed is
 * reported as `half-open` so the next request is allowed through as a probe.
 */
export function currentStateValue(
  state: CircuitBreakerState,
  config: CircuitBreakerConfig,
  now: number
): CircuitBreakerStateValue {
  if (
    state.state === "open" &&
    state.openedAt != null &&
    now - state.openedAt >= config.cooldownMs
  ) {
    return "half-open"
  }
  return state.state
}

export function recordSuccess(
  state: CircuitBreakerState,
  config: CircuitBreakerConfig,
  now: number
): CircuitBreakerState {
  const effective = currentStateValue(state, config, now)
  if (effective === "half-open") {
    const successCount = (state.state === "half-open" ? state.successCount : 0) + 1
    if (successCount >= config.successThreshold) {
      return {
        state: "closed",
        failureCount: 0,
        successCount: 0,
        lastFailureAt: state.lastFailureAt,
        openedAt: null,
        lastTransitionAt: now,
        blockedCount: state.blockedCount,
      }
    }
    return {
      ...state,
      state: "half-open",
      successCount,
      openedAt: state.openedAt,
      lastTransitionAt: state.state === "half-open" ? state.lastTransitionAt : now,
    }
  }
  // Healthy request while closed — clear any partial failure streak.
  if (state.failureCount === 0 && state.state === "closed") return state
  return { ...state, state: "closed", failureCount: 0, successCount: 0, openedAt: null }
}

export function recordFailure(
  state: CircuitBreakerState,
  config: CircuitBreakerConfig,
  now: number
): CircuitBreakerState {
  const effective = currentStateValue(state, config, now)
  if (effective === "half-open") {
    // A probe failed → straight back to open with a fresh cooldown.
    return {
      ...state,
      state: "open",
      successCount: 0,
      lastFailureAt: now,
      openedAt: now,
      lastTransitionAt: now,
    }
  }
  // Closed: count failures within the sliding window; an expired window resets.
  const withinWindow =
    state.lastFailureAt != null && now - state.lastFailureAt <= config.windowDurationMs
  const failureCount = (withinWindow ? state.failureCount : 0) + 1
  if (failureCount >= config.failureThreshold) {
    return {
      ...state,
      state: "open",
      failureCount,
      successCount: 0,
      lastFailureAt: now,
      openedAt: now,
      lastTransitionAt: now,
    }
  }
  return { ...state, state: "closed", failureCount, lastFailureAt: now }
}
