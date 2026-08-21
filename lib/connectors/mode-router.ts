/**
 * Mode router — Task 28, extended for the composed agent-mode axes (ADR-0117).
 *
 * Given a policy evaluation result and the conversation's engagement/autonomy,
 * decide how to handle an inbound event.
 *
 * The original three-value `ConnectorMode` version is kept as a projection
 * shim: it is still what `InboxSendPolicy.forcedMode` and the scheduled-digest
 * path speak, and every existing test asserts against it.
 */

import type { AutonomyLevel, EngagementMode } from "@cognia/agent-config-types/agent-composition"
import type { ConnectorMode } from "@/types/connectors/policy"
import {
  autonomyFromConnectorMode,
  engagementFromConnectorMode,
} from "./composition/mode-projection"
import type { PolicyEvalResult } from "./policy-eval"

/**
 * `draft-prepare` is retained only for the legacy shim.
 *
 * As an axis, "draft" is not a route at all — it is `autonomy: "suggest"`
 * producing `requireAcceptance`, which the DELIVERY stage reads. Routing it
 * separately is what made a team-bound conversation silently degrade to a
 * single-agent draft: the branch resolved no execution target, so the team it
 * was bound to never ran.
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
 * Legacy three-value entry point, now a projection over the axis router.
 *
 * Kept because `ConnectorMode` remains the compatibility mirror
 * (`InboxSendPolicy.forcedMode` is a live path in scheduled outbound, and the
 * plugin SDK mirrors the field). The projection is exact for `direct`, which is
 * all this signature can express — a caller holding a target should use
 * `routeInboundFromComposition`, whose `run` decision does not lose it.
 *
 * @param mode                      - Resolved connector mode.
 * @param evalResult                - Result of `evaluatePolicy`.
 * @param storeUnmatchedInDraftMode - From the resolved trigger policy.
 */
export function routeInbound(
  mode: ConnectorMode,
  evalResult: PolicyEvalResult,
  storeUnmatchedInDraftMode: boolean
): RouteDecision {
  const decision = routeInboundFromComposition({
    autonomy: autonomyFromConnectorMode(mode),
    engagement: engagementFromConnectorMode(mode, "direct"),
    evalResult,
    storeUnmatchedInDraftMode,
  })
  if (decision.kind !== "run") return decision.kind
  return decision.requireAcceptance ? "draft-prepare" : "ai-run"
}
