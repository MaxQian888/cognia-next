/**
 * Provider reliability telemetry sink (ADR-0043 Phase 4).
 *
 * Each completed chat turn feeds one outcome here; it fans out to the health
 * metrics collector (latency / success / cost rollups) and the circuit breaker
 * (trip on repeated failures). The routing engine reads both back via
 * `build-options` deps. Best-effort: telemetry never throws into the send path.
 */

import { useHealthMetricsStore } from "@/stores/settings/health-metrics-store"
import { useCircuitBreakerStore } from "@/stores/settings/circuit-breaker-store"

export interface ProviderOutcome {
  providerId: string
  ok: boolean
  latencyMs: number
  errorMessage?: string
  estimatedCostUsd?: number
}

export function recordProviderOutcome(outcome: ProviderOutcome): void {
  const { providerId, ok, latencyMs, errorMessage, estimatedCostUsd } = outcome
  if (!providerId) return
  try {
    useHealthMetricsStore.getState().record({
      providerId,
      success: ok,
      latencyMs: Number.isFinite(latencyMs) && latencyMs >= 0 ? latencyMs : 0,
      errorMessage: ok ? undefined : errorMessage,
      estimatedCostUsd,
    })
    const cb = useCircuitBreakerStore.getState()
    if (ok) cb.recordSuccess(providerId)
    else cb.recordFailure(providerId)
  } catch {
    // Telemetry must never break a send.
  }
}
