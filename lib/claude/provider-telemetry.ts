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
import { estimateCostFromTotals } from "@/lib/usage/session-analytics"
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
  /**
   * SDK-reported turn cost (USD). Authoritative when present (it bakes in cache
   * tiers). Absent/0 on the ai-sdk / non-Anthropic path — the sink then
   * estimates from the token breakdown below so the durable rollup isn't blank.
   */
  estimatedCostUsd?: number
  /** Model that served the turn — required for the durable cost rollup. */
  modelId?: string
  /** Total tokens used by the turn (input+output) when the SDK reports usage. */
  tokensUsed?: number
  /** Fresh input tokens — drives the cost estimate when no SDK cost is given. */
  inputTokens?: number
  /** Output tokens — drives the cost estimate when no SDK cost is given. */
  outputTokens?: number
  /** Cache-read tokens — priced at 0.1× input in the estimate. */
  cacheReadTokens?: number
  /** Cache-write tokens — priced at 1.25× input in the estimate. */
  cacheCreationTokens?: number
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
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    sessionId,
  } = outcome
  if (!providerId) return
  // Effective cost: the SDK figure wins; otherwise estimate from the token
  // breakdown + the model's pricing tables so non-Anthropic turns still feed
  // the budget mirror + daily rollup (which have no read-time back-fill, unlike
  // the usage-analytics tab). 0 when no SDK cost and no priced breakdown.
  const sdkCost =
    typeof estimatedCostUsd === "number" && estimatedCostUsd > 0 ? estimatedCostUsd : 0
  const effectiveCostUsd =
    sdkCost > 0
      ? sdkCost
      : modelId
        ? estimateCostFromTotals(
            {
              inputTokens: inputTokens ?? 0,
              outputTokens: outputTokens ?? 0,
              cacheReadInputTokens: cacheReadTokens ?? 0,
              cacheCreationInputTokens: cacheCreationTokens ?? 0,
            },
            modelId
          )
        : 0
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
      estimatedCostUsd: effectiveCostUsd > 0 ? effectiveCostUsd : undefined,
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
    if (ok && effectiveCostUsd > 0 && modelId) {
      useProviderCostMirrorStore.getState().addCost(providerId, effectiveCostUsd)
      void import("@/lib/db/provider-cost-daily")
        .then((m) => m.incrementProviderCost({ providerId, modelId, costUsd: effectiveCostUsd }))
        .catch(() => {})
    }
  } catch {
    // Telemetry must never break a send.
  }
}
