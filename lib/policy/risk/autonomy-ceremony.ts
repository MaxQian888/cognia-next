/**
 * Autonomy → ceremony floor, composed with the risk-derived ceremony.
 *
 * Two independent things decide what a run owes a human:
 *
 *   - **Risk** — what the run *can reach* (`classifyRisk` → `requiredCeremony`).
 *     Deterministic, gated on positive evidence, defaulting to `low` so the
 *     quick lane stays frictionless.
 *   - **Autonomy** — what the operator *chose* (`AutonomyLevel`). An operator
 *     who picked `suggest` wants every product reviewed even when the run
 *     touches nothing dangerous.
 *
 * Neither subsumes the other, so this module composes them field-wise with OR:
 * a checkpoint owed by either source is owed. That direction is the whole
 * safety property — it is impossible for a permissive autonomy level to cancel
 * a gate that risk raised. `autopilot` contributes an all-false floor, which is
 * why it removes the *operator's* requirement and nothing else; the operator's
 * escape hatch from a risk-raised gate remains the separate, visible
 * `riskGating` switch on the team config.
 *
 * Kept out of `./ceremony.ts` on purpose: that module is the tier→ceremony map
 * and has exactly one input. Adding a second axis there would make every
 * existing caller re-derive an autonomy value it does not have.
 */

import type { AutonomyLevel } from "@cognia/agent-config-types/agent-composition"

import type { RiskAssessment } from "./classify-risk"
import { requiredCeremony, type RequiredCeremony } from "./ceremony"

/** Every field false — contributes nothing to the composition. */
const NO_FLOOR: RequiredCeremony = {
  gate: false,
  requirePlanApproval: false,
  requireAcceptance: false,
  manualContinue: false,
}

/**
 * The ceremony an autonomy level owes on its own, before risk is considered.
 *
 * `observe` never runs a turn, so it owes nothing here — the no-run decision
 * belongs to the caller that reads engagement/autonomy, not to a ceremony map
 * that would otherwise claim a non-existent run needs approving.
 *
 * `suggest` is the level the IM connector's `draft` mode became:
 * `requireAcceptance` is what turns a finished reply into a draft awaiting a
 * human instead of an outbound message.
 *
 * `confirm` raises the surface-agnostic `gate` bit only. The per-tool
 * approval that gives `confirm` its meaning is enforced by the authority cap
 * (`default`) through the normal permission pipeline, not by a ceremony field.
 *
 * `manualContinue` is never raised by autonomy: holding *every turn* is a
 * property of a high-risk objective, not of an operator preference, and it is
 * interactive-only (a headless run that holds every turn never advances).
 */
export function ceremonyFloor(autonomy: AutonomyLevel): RequiredCeremony {
  switch (autonomy) {
    case "observe":
      return { ...NO_FLOOR }
    case "suggest":
      return {
        gate: true,
        requirePlanApproval: true,
        requireAcceptance: true,
        manualContinue: false,
      }
    case "confirm":
      return { ...NO_FLOOR, gate: true }
    case "act":
    case "autopilot":
      return { ...NO_FLOOR }
  }
}

/**
 * The ceremony a run actually owes: the field-wise OR of the operator's floor
 * and the risk-derived requirement.
 *
 * Callers that already OR in their own operator switch (Agent Team's
 * `requirePlanApproval`) keep doing so — this composes two policy sources, not
 * every source.
 */
export function effectiveCeremony(
  autonomy: AutonomyLevel,
  assessment: RiskAssessment
): RequiredCeremony {
  const floor = ceremonyFloor(autonomy)
  const risk = requiredCeremony(assessment)
  return {
    gate: floor.gate || risk.gate,
    requirePlanApproval: floor.requirePlanApproval || risk.requirePlanApproval,
    requireAcceptance: floor.requireAcceptance || risk.requireAcceptance,
    manualContinue: floor.manualContinue || risk.manualContinue,
  }
}
