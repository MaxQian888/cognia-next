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

import {
  DEFAULT_MAX_COOLDOWN_MS,
  DEFAULT_MIN_REQUEST_VOLUME,
  type CircuitBreakerConfig,
  type CircuitBreakerState,
  type CircuitBreakerStateValue,
} from "@/types/provider/circuit-breaker"

/** Per-failure options (Retry-After hint from the provider error). */
export interface RecordFailureOptions {
  retryAfterMs?: number
}

function effectiveCooldownMs(state: CircuitBreakerState, config: CircuitBreakerConfig): number {
  return state.dynamicCooldownMs ?? config.cooldownMs
}

function clampDynamicCooldown(
  retryAfterMs: number | undefined,
  config: CircuitBreakerConfig
): number | undefined {
  if (retryAfterMs === undefined || !Number.isFinite(retryAfterMs) || retryAfterMs <= 0) {
    return undefined
  }
  return Math.min(retryAfterMs, config.maxCooldownMs ?? DEFAULT_MAX_COOLDOWN_MS)
}

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
    now - state.openedAt >= effectiveCooldownMs(state, config)
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
        // dynamicCooldownMs + window counters intentionally dropped on close.
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
  // Failure-RATE mode: a closed-state success contributes window volume and
  // does NOT clear the failure streak (the ratio is what matters).
  if (config.failureRateThreshold !== undefined && state.state === "closed") {
    const windowed = rollWindow(state, config, now)
    return { ...windowed, windowRequestCount: (windowed.windowRequestCount ?? 0) + 1 }
  }
  // Healthy request while closed — clear any partial failure streak.
  if (state.failureCount === 0 && state.state === "closed") return state
  return { ...state, state: "closed", failureCount: 0, successCount: 0, openedAt: null }
}

/** Reset window counters when the counting window has expired (rate mode). */
function rollWindow(
  state: CircuitBreakerState,
  config: CircuitBreakerConfig,
  now: number
): CircuitBreakerState {
  const start = state.windowStartAt
  if (start == null || now - start > config.windowDurationMs) {
    return { ...state, failureCount: 0, windowRequestCount: 0, windowStartAt: now }
  }
  return state
}

export function recordFailure(
  state: CircuitBreakerState,
  config: CircuitBreakerConfig,
  now: number,
  opts?: RecordFailureOptions
): CircuitBreakerState {
  const effective = currentStateValue(state, config, now)
  const dynamicCooldownMs = clampDynamicCooldown(opts?.retryAfterMs, config)
  if (effective === "half-open") {
    // A probe failed → straight back to open with a fresh cooldown.
    return {
      ...state,
      state: "open",
      successCount: 0,
      lastFailureAt: now,
      openedAt: now,
      lastTransitionAt: now,
      ...(dynamicCooldownMs !== undefined ? { dynamicCooldownMs } : {}),
    }
  }

  if (config.failureRateThreshold !== undefined) {
    // Failure-RATE mode: count both outcomes in a rolling window keyed off
    // windowStartAt; trip on the ratio at minimum volume, with the absolute
    // threshold kept as a hard guard.
    const windowed = rollWindow(state, config, now)
    const failureCount = windowed.failureCount + 1
    const windowRequestCount = (windowed.windowRequestCount ?? 0) + 1
    const minVolume = config.minRequestVolume ?? DEFAULT_MIN_REQUEST_VOLUME
    const rateTrip =
      windowRequestCount >= minVolume &&
      failureCount / windowRequestCount >= config.failureRateThreshold
    const absoluteTrip = failureCount >= config.failureThreshold
    if (rateTrip || absoluteTrip) {
      return {
        ...windowed,
        state: "open",
        failureCount,
        windowRequestCount,
        successCount: 0,
        lastFailureAt: now,
        openedAt: now,
        lastTransitionAt: now,
        ...(dynamicCooldownMs !== undefined ? { dynamicCooldownMs } : {}),
      }
    }
    return {
      ...windowed,
      state: "closed",
      failureCount,
      windowRequestCount,
      lastFailureAt: now,
    }
  }

  // Absolute mode (historical): count failures within the sliding window; an
  // expired window resets.
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
      ...(dynamicCooldownMs !== undefined ? { dynamicCooldownMs } : {}),
    }
  }
  return { ...state, state: "closed", failureCount, lastFailureAt: now }
}
