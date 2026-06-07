/**
 * Provider reliability telemetry sink (ADR-0043 Phase 4).
 *
 * Each completed chat turn feeds one outcome here; it fans out to the health
 * metrics collector (latency / success / cost rollups), the circuit breaker
 * (trip on repeated failures, Retry-After-aware cooldowns) and the session
 * affinity map (pin a session to the deployment that served it). All stores
 * key by deployment (`providerId::modelId[::keyId]` — derived internally from
 * the outcome's providerId+modelId via the single codec in
 * `types/provider/deployment.ts`). The routing engine reads everything back
 * via `build-options` deps. Best-effort: telemetry never throws into the send
 * path.
 */

import { classifyProviderErrorInfo, isTransientErrorClass } from "@/lib/ai/routing/error-classifier"
import {
  pinSessionDeployment,
  releaseSessionDeployment,
} from "@/lib/ai/routing/session-affinity-store"
import { useHealthMetricsStore } from "@/stores/settings/health-metrics-store"
import { useCircuitBreakerStore } from "@/stores/settings/circuit-breaker-store"
import { useProviderCostMirrorStore } from "@/stores/settings/provider-cost-mirror-store"
import { useRateLimitStore } from "@/stores/settings/rate-limit-store"
import { deploymentKeyOf, DEPLOYMENT_MODEL_WILDCARD } from "@/types/provider/deployment"

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
  /**
   * Chat session the turn belongs to. When present, a successful turn pins
   * the session to this deployment (affinity routing) and a permanent failure
   * releases the pin.
   */
  sessionId?: string
}

export function recordProviderOutcome(outcome: ProviderOutcome): void {
  const {
    providerId,
    ok,
    latencyMs,
    errorMessage,
    estimatedCostUsd,
    modelId,
    tokensUsed,
    sessionId,
  } = outcome
  if (!providerId) return
  try {
    // Trailing-minute RPM/TPM window — success and failure both count as a
    // request against the deployment's (and provider's) rate ceiling.
    useRateLimitStore.getState().record(providerId, tokensUsed ?? 0, Date.now(), { modelId })
    useHealthMetricsStore.getState().record({
      providerId,
      modelId,
      success: ok,
      latencyMs: Number.isFinite(latencyMs) && latencyMs >= 0 ? latencyMs : 0,
      errorMessage: ok ? undefined : errorMessage,
      estimatedCostUsd,
    })
    const cb = useCircuitBreakerStore.getState()
    if (ok) {
      cb.recordSuccess(providerId, { modelId })
      if (sessionId) {
        const key = deploymentKeyOf({
          providerId,
          modelId: modelId ?? DEPLOYMENT_MODEL_WILDCARD,
        })
        if (key) pinSessionDeployment(sessionId, key)
      }
    } else {
      // Classify once: the breaker gets the Retry-After hint (dynamic
      // cooldown) and permanent failures release the session's affinity pin.
      const info = classifyProviderErrorInfo(errorMessage ?? "")
      cb.recordFailure(providerId, { modelId, retryAfterMs: info.retryAfterMs })
      if (sessionId && !isTransientErrorClass(info.errorClass)) {
        releaseSessionDeployment(sessionId)
      }
    }

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
