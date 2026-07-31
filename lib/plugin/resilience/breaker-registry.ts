/**
 * Per-plugin circuit-breaker registry.
 *
 * Wraps the REUSED `lib/connectors/circuit-breaker.ts:createCircuitBreaker`
 * (a clean per-instance factory) — this module adds no breaker logic, only a
 * process-singleton keyed store + the plugin-specific key conventions.
 *
 * Keys:
 *   - `${pluginId}::${toolName}` — per-tool invocation breaker
 *   - `load:${pluginId}`         — plugin module-load breaker
 *   - `activation:${pluginId}`   — lazy-activation breaker
 *
 * Consecutive-failure semantics come from config: we map our
 * `failureThreshold` onto the connector breaker's `minEvents` with a 100%
 * `failureThresholdPct`, so the breaker opens once the recent window is all
 * failures. A success drops the failure rate below 100% and defers opening —
 * the behavior we want for low/bursty per-tool traffic.
 */

import {
  createCircuitBreaker,
  type CircuitBreaker,
  type CircuitBreakerSnapshot,
} from "@/lib/connectors/circuit-breaker"

export interface PluginBreakerConfig {
  /** Consecutive failures within the window that open the breaker. */
  failureThreshold: number
  /** Time the breaker stays open before allowing a half-open probe (ms). */
  cooldownMs: number
  /** Half-open successes needed to close. */
  successThreshold: number
  /** Sliding window for the failure-rate calc (ms). Default 60_000. */
  windowMs?: number
  /** Injected clock — forwarded to the underlying breaker for tests. */
  now?: () => number
}

const DEFAULT_WINDOW_MS = 60_000

const breakers = new Map<string, CircuitBreaker>()

export function breakerKey(pluginId: string, toolName: string): string {
  return `${pluginId}::${toolName}`
}

export function loadBreakerKey(pluginId: string): string {
  return `load:${pluginId}`
}

export function activationBreakerKey(pluginId: string): string {
  return `activation:${pluginId}`
}

export function getOrCreateBreaker(key: string, config: PluginBreakerConfig): CircuitBreaker {
  const existing = breakers.get(key)
  if (existing) return existing
  const breaker = createCircuitBreaker({
    windowMs: config.windowMs ?? DEFAULT_WINDOW_MS,
    minEvents: Math.max(1, config.failureThreshold),
    failureThresholdPct: 100,
    cooldownMs: config.cooldownMs,
    closeOnSuccessCount: Math.max(1, config.successThreshold),
    now: config.now,
  })
  breakers.set(key, breaker)
  return breaker
}

/** Drop every breaker belonging to a plugin (per-tool + load + activation). */
export function resetPluginBreakers(pluginId: string): void {
  const toolPrefix = `${pluginId}::`
  const loadK = loadBreakerKey(pluginId)
  const activationK = activationBreakerKey(pluginId)
  for (const key of [...breakers.keys()]) {
    if (key === loadK || key === activationK || key.startsWith(toolPrefix)) {
      breakers.delete(key)
    }
  }
}

/** Snapshot every live breaker — pure read for the observability layer. */
export function snapshotAll(): Record<string, CircuitBreakerSnapshot> {
  const out: Record<string, CircuitBreakerSnapshot> = {}
  for (const [key, breaker] of breakers) {
    out[key] = breaker.snapshot()
  }
  return out
}

/** Snapshot a single key if it exists. */
export function snapshotKey(key: string): CircuitBreakerSnapshot | null {
  return breakers.get(key)?.snapshot() ?? null
}

/** Test-only: clear the whole registry. */
export function __resetRegistryForTesting(): void {
  breakers.clear()
}
