/**
 * In-memory circuit breaker for search providers.
 *
 * `search-service.ts` tries providers in priority order and falls back on
 * failure, but it re-tries a hard-down provider on every query — wasting a
 * round-trip (and, for paid providers, a billed call) each time. This breaker
 * tracks consecutive failures per provider and, once a provider trips, moves it
 * to the back of the try-order (and marks it "open") until a cooldown elapses,
 * after which a single probe ("half-open") is allowed. A success closes it.
 *
 * Consumes the `SearchProviderHealth` shape from `lib/search/types` (previously
 * defined but never populated). Pure/in-memory — no persistence; state resets on
 * reload, which is fine for a transient reliability signal.
 */

import type { SearchProviderType, SearchProviderHealth } from "./types"
import { DEFAULT_SEARCH_PROVIDER_HEALTH_SETTINGS } from "./types"

export type CircuitState = "closed" | "open" | "half-open"

export interface ProviderHealthConfig {
  /** Consecutive failures before the circuit opens. */
  failureThreshold: number
  /** How long (ms) a provider stays open before a half-open probe is allowed. */
  cooldownMs: number
  /** Master switch — when false, `orderByHealth` is identity and nothing trips. */
  enabled: boolean
}

/** Derived from the persisted-settings default so the two can never drift. */
export const DEFAULT_PROVIDER_HEALTH_CONFIG: ProviderHealthConfig = {
  ...DEFAULT_SEARCH_PROVIDER_HEALTH_SETTINGS,
}

/**
 * One row of the `snapshotAll` report: the shared `SearchProviderHealth`
 * diagnostics shape plus the raw counters and circuit position a Performance
 * panel needs to render "why is this provider parked".
 */
export interface ProviderHealthRow extends SearchProviderHealth {
  circuitState: CircuitState
  cooldownRemainingMs: number
  totalFailures: number
  totalSuccesses: number
  consecutiveFailures: number
}

interface ProviderState {
  consecutiveFailures: number
  /** Wall-clock ms when the circuit last opened; null while closed. */
  openedAt: number | null
  totalFailures: number
  totalSuccesses: number
  /** Sum of success latencies (ms); `snapshot` derives `avgLatency` from it. */
  totalSuccessLatency: number
}

function emptyState(): ProviderState {
  return {
    consecutiveFailures: 0,
    openedAt: null,
    totalFailures: 0,
    totalSuccesses: 0,
    totalSuccessLatency: 0,
  }
}

/** Per-provider circuit breaker. Injectable clock for deterministic tests. */
export class ProviderHealth {
  private config: ProviderHealthConfig
  private states = new Map<string, ProviderState>()
  private now: () => number

  constructor(config: Partial<ProviderHealthConfig> = {}, now: () => number = () => Date.now()) {
    this.config = { ...DEFAULT_PROVIDER_HEALTH_CONFIG, ...config }
    this.now = now
  }

  setConfig(config: Partial<ProviderHealthConfig>): void {
    this.config = { ...this.config, ...config }
  }

  /** The live config (a copy — mutating the result changes nothing). */
  getConfig(): ProviderHealthConfig {
    return { ...this.config }
  }

  private state(provider: string): ProviderState {
    let s = this.states.get(provider)
    if (!s) {
      s = emptyState()
      this.states.set(provider, s)
    }
    return s
  }

  /**
   * Record the outcome of a provider call. Opens the circuit past the
   * threshold. `latencyMs` (finite, ≥ 0) feeds `snapshot().avgLatency`;
   * anything else is ignored so a missing timer never skews the average.
   */
  recordResult(provider: string, ok: boolean, latencyMs?: number): void {
    if (!this.config.enabled) return
    const s = this.state(provider)
    if (ok) {
      s.consecutiveFailures = 0
      s.openedAt = null
      s.totalSuccesses += 1
      if (typeof latencyMs === "number" && Number.isFinite(latencyMs) && latencyMs >= 0) {
        s.totalSuccessLatency += latencyMs
      }
      return
    }
    s.consecutiveFailures += 1
    s.totalFailures += 1
    if (s.consecutiveFailures >= this.config.failureThreshold) {
      s.openedAt = this.now()
    }
  }

  /** Current circuit state for a provider. */
  circuitState(provider: string): CircuitState {
    const s = this.states.get(provider)
    if (!s || s.openedAt == null) return "closed"
    return this.now() - s.openedAt >= this.config.cooldownMs ? "half-open" : "open"
  }

  /** True only while the circuit is open AND still within its cooldown. */
  isOpen(provider: string): boolean {
    return this.config.enabled && this.circuitState(provider) === "open"
  }

  /** Milliseconds left in the open-circuit cooldown; 0 when not open. */
  cooldownRemainingMs(provider: string): number {
    if (!this.isOpen(provider)) return 0
    const openedAt = this.states.get(provider)?.openedAt
    if (openedAt == null) return 0
    return Math.max(0, this.config.cooldownMs - (this.now() - openedAt))
  }

  /**
   * Stable reorder that moves still-open providers to the back (closed and
   * half-open keep their relative order at the front). Identity when disabled.
   */
  orderByHealth<T extends { providerId: SearchProviderType }>(providers: T[]): T[] {
    if (!this.config.enabled) return providers
    const healthy: T[] = []
    const open: T[] = []
    for (const p of providers) {
      if (this.isOpen(p.providerId)) open.push(p)
      else healthy.push(p)
    }
    return open.length === 0 ? providers : [...healthy, ...open]
  }

  /** Snapshot for UI/diagnostics, in the shared `SearchProviderHealth` shape. */
  snapshot(provider: string): SearchProviderHealth {
    const s = this.states.get(provider)
    const open = this.circuitState(provider) === "open"
    const total = (s?.totalFailures ?? 0) + (s?.totalSuccesses ?? 0)
    const successRate = total > 0 ? (s?.totalSuccesses ?? 0) / total : 1
    return {
      status:
        !s || total === 0
          ? "unknown"
          : open
            ? "unhealthy"
            : successRate < 0.5
              ? "degraded"
              : "healthy",
      avgLatency:
        s && s.totalSuccesses > 0 ? Math.round(s.totalSuccessLatency / s.totalSuccesses) : 0,
      successRate,
      circuitBreakerOpen: open,
      lastChecked: this.now(),
    }
  }

  /**
   * One row per known provider id — the Performance panel's data source.
   * Providers with no recorded traffic still get a row (`status: "unknown"`).
   */
  snapshotAll(providerIds: readonly string[]): Record<string, ProviderHealthRow> {
    const out: Record<string, ProviderHealthRow> = {}
    for (const providerId of providerIds) {
      const s = this.states.get(providerId) ?? emptyState()
      out[providerId] = {
        ...this.snapshot(providerId),
        circuitState: this.circuitState(providerId),
        cooldownRemainingMs: this.cooldownRemainingMs(providerId),
        totalFailures: s.totalFailures,
        totalSuccesses: s.totalSuccesses,
        consecutiveFailures: s.consecutiveFailures,
      }
    }
    return out
  }

  reset(provider?: string): void {
    if (provider) this.states.delete(provider)
    else this.states.clear()
  }
}

let instance: ProviderHealth | null = null

/** Shared singleton consumed by `search-service`. */
export function getProviderHealth(): ProviderHealth {
  if (!instance) instance = new ProviderHealth()
  return instance
}

/** Drop the shared breaker (tests / config reload). */
export function resetProviderHealth(): void {
  instance = null
}
