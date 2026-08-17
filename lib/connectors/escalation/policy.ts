/**
 * Pure helpers over `EscalationPolicy` (IM delegation slice 1B): which steps
 * are due for an overdue conversation, and whether an operator-authored
 * policy is well-formed. No I/O — the sweep and the editors both consume
 * these so the "when does step N fire" rule cannot drift between them.
 */

import {
  ESCALATION_ACTION_TYPES,
  MAX_ESCALATION_STEPS,
  type EscalationAction,
  type EscalationPolicy,
  type EscalationStep,
} from "@/types/connectors/escalation"

export interface DueStep {
  /** 0-based index into `policy.steps`. */
  index: number
  step: EscalationStep
}

/**
 * Steps that should fire now: every step whose `afterOverdueMinutes` has been
 * reached, in order, skipping steps at or below `escalatedStep` (the last
 * step already fired for this overdue window). `undefined` escalatedStep
 * means nothing fired yet. Negative overdue (not yet due) → none.
 */
export function dueSteps(
  policy: EscalationPolicy | undefined,
  overdueMinutes: number,
  escalatedStep: number | undefined
): DueStep[] {
  if (!policy || !Array.isArray(policy.steps) || policy.steps.length === 0) return []
  if (!Number.isFinite(overdueMinutes) || overdueMinutes < 0) return []
  const from = escalatedStep === undefined ? 0 : escalatedStep + 1
  const due: DueStep[] = []
  for (let index = from; index < policy.steps.length; index++) {
    const step = policy.steps[index]
    if (!step) continue
    if (step.afterOverdueMinutes <= overdueMinutes) due.push({ index, step })
    // Steps are validated ascending, so the first not-yet-due step ends the scan.
    else break
  }
  return due
}

/** Minutes past the deadline (>= 0), or a negative number when not yet due. */
export function overdueMinutesAt(nextResponseDueAt: number, now: number): number {
  return (now - nextResponseDueAt) / 60_000
}

export type EscalationPolicyIssue =
  | { code: "too_many_steps"; max: number }
  | { code: "step_minutes_invalid"; step: number }
  | { code: "steps_not_ascending"; step: number }
  | { code: "step_without_actions"; step: number }
  | { code: "action_type_unknown"; step: number; action: number }
  | { code: "reassign_target_missing"; step: number; action: number }
  | { code: "switch_mode_invalid"; step: number; action: number }
  | { code: "urgent_users_missing"; step: number; action: number }

export interface EscalationPolicyValidation {
  ok: boolean
  issues: EscalationPolicyIssue[]
}

function isValidAction(
  action: EscalationAction,
  step: number,
  index: number
): EscalationPolicyIssue[] {
  const issues: EscalationPolicyIssue[] = []
  if (!action || !ESCALATION_ACTION_TYPES.includes(action.type)) {
    return [{ code: "action_type_unknown", step, action: index }]
  }
  switch (action.type) {
    case "reassign": {
      const a = action.assignee
      const ok =
        a?.kind === "human" ||
        ((a?.kind === "character" || a?.kind === "team") && typeof a.id === "string" && a.id.trim())
      if (!ok) issues.push({ code: "reassign_target_missing", step, action: index })
      break
    }
    case "switchMode":
      if (action.mode !== "manual" && action.mode !== "draft") {
        issues.push({ code: "switch_mode_invalid", step, action: index })
      }
      break
    case "urgent":
      if (!Array.isArray(action.userIds) || action.userIds.filter((u) => u?.trim()).length === 0) {
        issues.push({ code: "urgent_users_missing", step, action: index })
      }
      break
    case "notify":
      break
  }
  return issues
}

/**
 * Validate an operator-authored policy: at most `MAX_ESCALATION_STEPS`
 * steps, every `afterOverdueMinutes` a finite integer >= 0 in strictly
 * ascending order, every step with >= 1 action, and every action carrying
 * the fields its type needs. An empty `steps` array IS valid (it means
 * "escalation off for this scope").
 */
export function validateEscalationPolicy(policy: EscalationPolicy): EscalationPolicyValidation {
  const issues: EscalationPolicyIssue[] = []
  const steps = Array.isArray(policy?.steps) ? policy.steps : []
  if (steps.length > MAX_ESCALATION_STEPS) {
    issues.push({ code: "too_many_steps", max: MAX_ESCALATION_STEPS })
  }
  let previous = -1
  steps.forEach((step, index) => {
    const minutes = step?.afterOverdueMinutes
    if (!Number.isFinite(minutes) || minutes < 0 || !Number.isInteger(minutes)) {
      issues.push({ code: "step_minutes_invalid", step: index })
    } else {
      if (minutes <= previous) issues.push({ code: "steps_not_ascending", step: index })
      previous = minutes
    }
    if (!Array.isArray(step?.actions) || step.actions.length === 0) {
      issues.push({ code: "step_without_actions", step: index })
    } else {
      step.actions.forEach((action, actionIndex) => {
        issues.push(...isValidAction(action, index, actionIndex))
      })
    }
  })
  return { ok: issues.length === 0, issues }
}
