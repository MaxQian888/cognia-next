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
import { useProviderCostMirrorStore } from "@/stores/settings/provider-cost-mirror-store"
import { useRateLimitStore } from "@/stores/settings/rate-limit-store"

export interface ProviderOutcome {
  providerId: string
  ok: boolean
  latencyMs: number
  errorMessage?: string
  estimatedCostUsd?: number
  /** Model that served the turn — required for the durable cost rollup. */
  modelId?: string
  /** Total tokens used by the turn (input+output) when the SDK reports usage. */
  tokensUsed?: number
}

export function recordProviderOutcome(outcome: ProviderOutcome): void {
  const { providerId, ok, latencyMs, errorMessage, estimatedCostUsd, modelId, tokensUsed } = outcome
  if (!providerId) return
  try {
    // Trailing-minute RPM/TPM window — success and failure both count as a
    // request against the provider's rate ceiling.
    useRateLimitStore.getState().record(providerId, tokensUsed ?? 0)
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

    // Durable daily cost rollup (only successful turns carry real cost).
    // Mirror update is synchronous so the routing engine's budget check sees
    // it immediately; the Dexie write is fire-and-forget off the send path.
    if (ok && typeof estimatedCostUsd === "number" && estimatedCostUsd > 0 && modelId) {
      useProviderCostMirrorStore.getState().addCost(providerId, estimatedCostUsd)
      void import("@/lib/db/provider-cost-daily")
        .then((m) => m.incrementProviderCost({ providerId, modelId, costUsd: estimatedCostUsd }))
        .catch(() => {})
    }
  } catch {
    // Telemetry must never break a send.
  }
}
