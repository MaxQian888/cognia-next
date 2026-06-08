/**
 * Forward `gateway://request-outcome` events into the shared provider
 * telemetry sink, so traffic served through the inbound gateway trains the
 * same health / circuit-breaker / cost stores the chat plane reads.
 *
 * Pure mapping function + a thin event-listener wirer; the
 * `gateway-provider` component owns the Tauri event subscription lifecycle.
 */

import { recordProviderOutcome, type ProviderOutcome } from "@/lib/claude/provider-telemetry"
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
  }
}

/** Record one gateway outcome into the telemetry stores. Best-effort. */
export function forwardGatewayOutcome(o: GatewayRequestOutcome): void {
  recordProviderOutcome(gatewayOutcomeToProviderOutcome(o))
}
