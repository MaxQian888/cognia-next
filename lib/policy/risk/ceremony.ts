/**
 * Risk tier → required human ceremony.
 *
 * Deliberately trivial and centralized: consumers ask "what does this run owe a
 * human?" instead of re-deriving it from the tier, so the tier→ceremony mapping
 * lives in exactly one place.
 *
 * The shape is defined in full up front — including the fields only /goal
 * (Phase 2) reads — so wiring a second surface adds no field and forces no
 * re-test of this map. Consumers read only the fields they use; Phase 1
 * (Agent Team) reads `requirePlanApproval`. Per ADR-0070.
 */

import type { RiskAssessment } from "./classify-risk"

export interface RequiredCeremony {
  /**
   * Any ceremony at all is owed — the surface-agnostic "this run is not in the
   * Quick lane" bit. True for every non-`low` tier. Surfaces without a specific
   * gate of their own can read this alone.
   */
  gate: boolean
  /**
   * Agent Team: raise the plan-approval gate even when the operator left
   * `requirePlanApproval` off. Never lowers an operator-set gate — consumers OR
   * this with the configured value.
   */
  requirePlanApproval: boolean
  /**
   * /goal: park the goal at `awaitingAcceptance` on completion for human
   * sign-off rather than auto-completing.
   */
  requireAcceptance: boolean
  /**
   * /goal: hold each turn for a human. **Interactive only** — a headless goal
   * that holds every turn never advances, so the /goal wiring must not apply
   * this under a headless origin (the tier alone cannot know the origin, so the
   * consumer, not this map, is responsible for that check).
   */
  manualContinue: boolean
}

/** Every field false — the Quick lane. */
const NO_CEREMONY: RequiredCeremony = {
  gate: false,
  requirePlanApproval: false,
  requireAcceptance: false,
  manualContinue: false,
}

/**
 * `low` owes nothing — the Quick lane must stay frictionless, which is the whole
 * reason the classifier gates on positive evidence rather than on uncertainty.
 *
 * `medium` and `high` both owe a plan approval and an acceptance; they differ
 * only in `manualContinue`, which turns a high-risk goal from "check the result"
 * into "watch every turn".
 */
export function requiredCeremony(assessment: RiskAssessment): RequiredCeremony {
  if (assessment.tier === "low") return { ...NO_CEREMONY }
  return {
    gate: true,
    requirePlanApproval: true,
    requireAcceptance: true,
    manualContinue: assessment.tier === "high",
  }
}
