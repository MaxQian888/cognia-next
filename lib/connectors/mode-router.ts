/**
 * Mode router — Task 28, extended for the composed agent-mode axes (ADR-0117).
 *
 * Given a policy evaluation result and the conversation's engagement/autonomy,
 * decide how to handle an inbound event.
 *
 * `ConnectorMode` is still the stored compatibility mirror — it is what
 * `InboxSendPolicy.forcedMode` and the scheduled-digest path speak — but it is
 * no longer an INPUT to routing. Deriving the axes from it, as the old
 * `routeInbound(mode, …)` did, forced `targetKind: "direct"` and made every
 * axis a conversation actually stored inert.
 */

import type { AutonomyLevel, EngagementMode } from "@cognia/agent-config-types/agent-composition"
import type { PolicyEvalResult } from "./policy-eval"

/**
 * The vocabulary the route handler and the governance producer speak.
 *
 * `draft-prepare` is a projection artefact, not a route: as an axis, "draft"
 * is `autonomy: "suggest"` producing `requireAcceptance`, which the DELIVERY
 * stage reads. Routing it separately is what made a team-bound conversation
 * silently degrade to a single-agent draft — that branch resolved no execution
 * target, so the team it was bound to never ran.
 */
export type RouteDecision = "ai-run" | "manual-store" | "draft-prepare" | "store-only" | "drop"

/**
 * What an inbound event should do, in axis terms.
 *
 * `run` is one decision with a modifier rather than two decisions, which is the
 * whole point: whether a reply ships or waits for a human is a property of the
 * PRODUCT, not of which executor produced it.
 */
export interface CompositionRouteDecision {
  kind: "run" | "manual-store" | "store-only" | "drop"
  /**
   * The turn runs normally and its product is held for a human instead of
   * being delivered. Only ever set with `kind: "run"`.
   */
  requireAcceptance: boolean
}

/**
 * Decide how to handle an inbound event from the composition axes.
 *
 * `observe` / `human` never run a turn — that is what those values mean. Every
 * other autonomy level runs; the only difference is whether the result is
 * delivered or drafted, and that is `suggest`'s `requireAcceptance`.
 */
export function routeInboundFromComposition(input: {
  engagement: EngagementMode
  autonomy: AutonomyLevel
  evalResult: PolicyEvalResult
  storeUnmatchedInDraftMode: boolean
}): CompositionRouteDecision {
  const { matched, blocked } = input.evalResult
  if (input.engagement === "human" || input.autonomy === "observe") {
    // Always stored for human review, regardless of policy match/block: the
    // work belongs to a person, and a person needs to see what arrived.
    return { kind: "manual-store", requireAcceptance: false }
  }
  if (!matched || blocked) {
    return {
      kind: input.storeUnmatchedInDraftMode ? "store-only" : "drop",
      requireAcceptance: false,
    }
  }
  return { kind: "run", requireAcceptance: input.autonomy === "suggest" }
}

/**
 * Project an axis decision onto the legacy five-value `RouteDecision`.
 *
 * The route handler, the governance producer and every existing test speak
 * this vocabulary, so the projection has to exist — but it belongs in exactly
 * one place. `requireAcceptance` survives it as `draft-prepare`, which the
 * runtime reads as "run, hold the product", NOT as a second execution path.
 *
 * This replaces `routeInbound(mode, …)`, which took a `ConnectorMode` and so
 * could only ever assume `targetKind: "direct"`.
 */
export function toRouteDecision(decision: CompositionRouteDecision): RouteDecision {
  if (decision.kind !== "run") return decision.kind
  return decision.requireAcceptance ? "draft-prepare" : "ai-run"
}
