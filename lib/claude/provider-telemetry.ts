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

import {
  classifyProviderErrorInfo,
  isTransientErrorClass,
} from "@cognia/provider-routing/error-classifier"
import {
  pinSessionDeployment,
  releaseSessionDeployment,
} from "@cognia/provider-routing/session-affinity-store"
import { estimateCostFromTotals } from "@/lib/usage/session-analytics"
import { useHealthMetricsStore } from "@/stores/settings/health-metrics-store"
import { useCircuitBreakerStore } from "@/stores/settings/circuit-breaker-store"
import { useProviderCostMirrorStore } from "@/stores/settings/provider-cost-mirror-store"
import { useRateLimitStore } from "@/stores/settings/rate-limit-store"
import { deploymentKeyOf, DEPLOYMENT_MODEL_WILDCARD } from "@cognia/provider-types/deployment"
import { emitFinishedSpan } from "@cognia/agent-trace/emitter"
import type { SpanSurface } from "@/types/agent-trace/span"

export interface ProviderOutcome {
  providerId: string
  ok: boolean
  latencyMs: number
  errorMessage?: string
  /**
   * Real HTTP status from the failing response (`session_ended.httpStatus`),
   * when the sidecar captured it. Lets the classifier rescue an otherwise
   * unclassifiable error message.
   */
  httpStatus?: number
  /**
   * Real Retry-After delay (ms) from the failing response header
   * (`session_ended.retryAfterMs`). Feeds the breaker's dynamic cooldown,
   * preferred over the value string-extracted from the message.
   */
  retryAfterMs?: number
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
  /**
   * W3C trace id of the owning turn (from `SendOptions.traceId`). When present
   * — together with `sessionId` — the sink emits a provider CHILD span so the
   * LLM call (with its tokens + cost) joins the turn's trace in the waterfall /
   * OTLP / Langfuse. Absent on older call sites → no span (back-compat).
   */
  traceId?: string
  /** Root/parent span id (`SendOptions.spanId`) the provider child span nests under. */
  parentSpanId?: string
  /** Surface that drove the turn — tags the child span. Defaults to "chat". */
  surface?: SpanSurface
}

let missingTraceContextCount = 0

export function getMissingProviderTraceContextCount(): number {
  return missingTraceContextCount
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
    httpStatus,
    retryAfterMs,
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
            modelId,
            providerId
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
      // The structured meta (real status + Retry-After header) takes precedence
      // over the string-derived hint when the sidecar captured it.
      const info = classifyProviderErrorInfo(errorMessage ?? "", { httpStatus, retryAfterMs })
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

  // Agent-trace provider CHILD span: the LLM call as a child of the turn's root
  // span, carrying token usage + cost for the waterfall / OTLP / Langfuse. Kept
  // in its own try, AFTER (and independent of) the routing/breaker/cost fan-out
  // above — additive, never reshaping that path. Skipped when the caller did
  // not thread a `traceId` (older sites) or has no `sessionId`
  // (`emitFinishedSpan` drops identity-less spans).
  if (outcome.traceId && sessionId) {
    try {
      emitFinishedSpan({
        traceId: outcome.traceId,
        parentSpanId: outcome.parentSpanId,
        operationName: "chat",
        // The narrow `SpanProviderName` union only models anthropic|openai|
        // cognia.*; arbitrary providerIds bucket to "openai" with the true id
        // preserved in `metadata.providerId` (OTLP / waterfall read metadata).
        providerName: providerId === "anthropic" ? "anthropic" : "openai",
        sessionId,
        surface: outcome.surface ?? "chat",
        requestModel: modelId,
        responseModel: modelId,
        durationMs: Number.isFinite(latencyMs) && latencyMs >= 0 ? latencyMs : 0,
        usage: {
          inputTokens: inputTokens ?? 0,
          outputTokens: outputTokens ?? 0,
          cacheCreationTokens: cacheCreationTokens ?? 0,
          cacheReadTokens: cacheReadTokens ?? 0,
        },
        costUsdEstimate: effectiveCostUsd > 0 ? effectiveCostUsd : undefined,
        errorType: ok ? undefined : "provider_error",
        errorMessage: ok ? undefined : errorMessage,
        metadata: { providerId },
      })
    } catch {
      // Span emission is best-effort — never break a send.
    }
  } else if (sessionId && !outcome.traceId) {
    missingTraceContextCount += 1
    if (process.env.NODE_ENV !== "production") {
      console.warn("provider telemetry dropped a span because traceId was not threaded", {
        providerId,
        sessionId,
      })
    }
  }
}

export const __TESTING__ = {
  resetMissingTraceContextCount(): void {
    missingTraceContextCount = 0
  },
}
