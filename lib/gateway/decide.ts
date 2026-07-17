/**
 * Resolve a gateway live-routing decision: run the same routing engine the
 * chat send path uses (difficulty router, real-time strategy, health /
 * circuit / budget) and return the pre-ordered candidate chain the gateway
 * should walk. An empty list tells the gateway to fall back to its snapshot.
 *
 * Pure-with-injected-engine: the engine factory is passed in so this is unit-
 * testable without the live stores.
 */

import { RoutingNoCandidatesError } from "@cognia/provider-routing/provider-routing-engine"
import type { ProviderRoutingEngine } from "@cognia/provider-routing/provider-routing-engine"
import type { GatewaySnapshotEntry } from "@/types/gateway"

export interface GatewayDecideRequest {
  requestId: string
  model: string
  promptText?: string | null
  estimatedInputTokens?: number | null
  /** Gateway-derived affinity key (W1.3) — lets the routing engine's
   * session-affinity filter stick this conversation to one deployment. */
  sessionId?: string | null
}

/**
 * Compute the ordered candidate entries for a decide request. Returns `[]`
 * when the model isn't an alias (the gateway's snapshot resolution handles
 * `provider:model` / bare ids) or when every candidate is unavailable.
 */
export function resolveGatewayDecision(
  req: GatewayDecideRequest,
  engine: ProviderRoutingEngine
): GatewaySnapshotEntry[] {
  let result
  try {
    result = engine.selectProvider({
      model: req.model,
      ...(req.promptText ? { promptText: req.promptText } : {}),
      ...(req.estimatedInputTokens != null
        ? { estimatedInputTokens: req.estimatedInputTokens }
        : {}),
      ...(req.sessionId ? { sessionId: req.sessionId } : {}),
    })
  } catch (err) {
    // Alias matched but every deployment is unavailable → empty = let the
    // gateway try its snapshot (which may still surface something).
    if (err instanceof RoutingNoCandidatesError) return []
    throw err
  }
  // No alias match (or no direct provider+model) → defer to the snapshot.
  if (!result || !result.fromAlias) return []
  return [
    { providerId: result.providerId, modelId: result.modelId },
    ...result.fallbackEntries.map((e) => ({ providerId: e.providerId, modelId: e.modelId })),
  ]
}
