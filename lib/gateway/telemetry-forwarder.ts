/**
 * Forward `gateway://request-outcome` events into the shared provider
 * telemetry sink, so traffic served through the inbound gateway trains the
 * same health / circuit-breaker / cost stores the chat plane reads.
 *
 * Pure mapping function + a thin event-listener wirer; the
 * `gateway-provider` component owns the Tauri event subscription lifecycle.
 */

import { recordProviderOutcome, type ProviderOutcome } from "@/lib/claude/provider-telemetry"
import { recordSurfaceUsage, swallowUsageWrite } from "@/lib/db/session-usage"
import type { GatewayRequestOutcome } from "@/types/gateway"

/** Map a gateway outcome onto the chat-plane `ProviderOutcome` shape. */
export function gatewayOutcomeToProviderOutcome(o: GatewayRequestOutcome): ProviderOutcome {
  const tokensUsed =
    o.inputTokens != null || o.outputTokens != null
      ? (o.inputTokens ?? 0) + (o.outputTokens ?? 0)
      : undefined
  return {
    providerId: o.providerId,
    modelId: o.modelId,
    ok: o.ok,
    latencyMs: o.latencyMs,
    ...(o.errorMessage ? { errorMessage: o.errorMessage } : {}),
    ...(tokensUsed !== undefined ? { tokensUsed } : {}),
    // Forward the token breakdown so the telemetry sink can estimate cost
    // (the gateway outcome carries no SDK cost figure of its own).
    ...(o.inputTokens != null ? { inputTokens: o.inputTokens } : {}),
    ...(o.outputTokens != null ? { outputTokens: o.outputTokens } : {}),
    // W1.3: threading the session key lets a successful gateway turn pin the
    // deployment (affinity routing) and a permanent failure release it — the
    // same machinery the chat plane uses.
    ...(o.sessionId ? { sessionId: o.sessionId } : {}),
    // W1.1: the upstream-derived cooldown window feeds the breaker's dynamic
    // cooldown (previously only the chat/sidecar path supplied it).
    ...(o.retryAfterMs != null ? { retryAfterMs: o.retryAfterMs } : {}),
  }
}

/**
 * Deterministic ledger key for one gateway outcome.
 *
 * The gateway emits an outcome exactly once per served request and carries no
 * request id of its own, so the key is built from the identity it does carry
 * plus the arrival clock. Two outcomes for the same deployment in the same
 * millisecond would collapse into one row, which is the correct failure
 * direction for a billing ledger: under-count a pathological tie rather than
 * double-count every ordinary request.
 */
export function gatewayUsageOperationId(o: GatewayRequestOutcome, at: number): string {
  const session = o.sessionId ?? "anon"
  return `gw:${o.providerId}:${o.modelId}:${session}:${at}`
}

/**
 * Record one gateway outcome into the telemetry stores AND the usage ledger.
 *
 * The ledger write is what keeps gateway traffic in the budget projection.
 * Before ADR-0165 this path reached `providerCostDaily` through the telemetry
 * sink's own rollup, which no longer exists: `sessionUsage` is the money and
 * the rollup is derived from it, so a turn that writes no ledger row is a turn
 * that does not exist. Failed requests bill nothing and write nothing.
 */
export function forwardGatewayOutcome(o: GatewayRequestOutcome, now: number = Date.now()): void {
  recordProviderOutcome(gatewayOutcomeToProviderOutcome(o))
  if (!o.ok) return
  const inputTokens = o.inputTokens ?? 0
  const outputTokens = o.outputTokens ?? 0
  if (inputTokens === 0 && outputTokens === 0) return
  swallowUsageWrite(
    recordSurfaceUsage({
      surface: "gateway",
      operationId: gatewayUsageOperationId(o, now),
      scopeId: o.sessionId ?? o.providerId,
      usage: {
        inputTokens,
        outputTokens,
        durationMs: o.latencyMs,
        model: o.modelId,
        providerId: o.providerId,
        // The gateway reports tokens the upstream returned but never a cost,
        // so the ledger prices them locally and says so.
        usageBasis: "provider-reported",
      },
      at: now,
    })
  )
}
