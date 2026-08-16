/**
 * The nine-step Creator workflow (ADR-0117, Phase 3).
 *
 * The ordering is not cosmetic — it is the security property. `apply-changes`
 * is the first step allowed to write, and it sits *after* `approve-permissions`
 * precisely so that no file lands before the user has seen what capabilities
 * the artifact asks for. `canAdvance` enforces that ordering rather than
 * trusting callers to walk the list politely.
 *
 * Progress is expressed as workflow run events (`lib/creator/run-log.ts`), not
 * as a new project database.
 */

import type { CreatorApprovalKind, CreatorStepDefinition, CreatorStepId } from "@/types/creator"

/** The nine steps in execution order. */
export const CREATOR_STEPS: readonly CreatorStepDefinition[] = [
  { id: "collect-requirements", repeatable: true },
  // Working Rule 1 as a workflow step: look for an existing implementation
  // before generating a new one.
  { id: "survey-existing", repeatable: true },
  { id: "plan-scaffold", repeatable: true },
  { id: "approve-permissions", requiresApproval: "permission-widening" },
  { id: "apply-changes", writes: true },
  { id: "verify", repeatable: true },
  { id: "preview", repeatable: true },
  { id: "review", repeatable: true },
  // The delivery gate covers install/export/publish. Which of the three is
  // being approved is carried on the approval record, not baked into the step.
  { id: "approve-delivery", requiresApproval: "install" },
]

export const CREATOR_STEP_IDS: readonly CreatorStepId[] = CREATOR_STEPS.map((step) => step.id)

const STEP_BY_ID = new Map<CreatorStepId, CreatorStepDefinition>(
  CREATOR_STEPS.map((step) => [step.id, step])
)

export function creatorStep(id: CreatorStepId): CreatorStepDefinition {
  const step = STEP_BY_ID.get(id)
  if (!step) throw new Error(`Unknown Creator step: ${id}`)
  return step
}

export function creatorStepIndex(id: CreatorStepId): number {
  return CREATOR_STEP_IDS.indexOf(id)
}

/** The step after `id`, or `undefined` when `id` is the last one. */
export function nextCreatorStep(id: CreatorStepId): CreatorStepId | undefined {
  const index = creatorStepIndex(id)
  if (index < 0) throw new Error(`Unknown Creator step: ${id}`)
  return CREATOR_STEP_IDS[index + 1]
}

export function isTerminalCreatorStep(id: CreatorStepId): boolean {
  return creatorStepIndex(id) === CREATOR_STEP_IDS.length - 1
}

export interface CreatorAdvanceState {
  /** Steps already completed. Order-insensitive; the check derives ordering. */
  completed: readonly CreatorStepId[]
  /** Approvals the user has granted for this run. */
  approvals: readonly CreatorApprovalKind[]
}

export type CreatorAdvanceBlock =
  | { allowed: true }
  | {
      allowed: false
      reason: "unknown-step" | "out-of-order" | "already-completed" | "awaiting-approval"
      /** The approval still needed, when `reason` is `awaiting-approval`. */
      approval?: CreatorApprovalKind
      /** The first incomplete predecessor, when `reason` is `out-of-order`. */
      blockedBy?: CreatorStepId
    }

/**
 * Whether `id` may run given what has already completed and been approved.
 *
 * A step is blocked when any earlier step is incomplete, when it has already
 * completed and is not repeatable, or when it declares an approval the user has
 * not granted.
 */
export function canAdvance(id: CreatorStepId, state: CreatorAdvanceState): CreatorAdvanceBlock {
  const index = creatorStepIndex(id)
  if (index < 0) return { allowed: false, reason: "unknown-step" }

  const completed = new Set(state.completed)
  const blockedBy = CREATOR_STEP_IDS.slice(0, index).find((prior) => !completed.has(prior))
  if (blockedBy) return { allowed: false, reason: "out-of-order", blockedBy }

  const step = CREATOR_STEPS[index]
  if (completed.has(id) && !step.repeatable) {
    return { allowed: false, reason: "already-completed" }
  }

  if (step.requiresApproval && !state.approvals.includes(step.requiresApproval)) {
    return { allowed: false, reason: "awaiting-approval", approval: step.requiresApproval }
  }

  return { allowed: true }
}

/**
 * Whether writing to the authoring root is permitted right now.
 *
 * Kept separate from `canAdvance` so the file layer can assert it directly:
 * a write that reaches disk without the permission diff having been approved is
 * the exact failure this phase exists to prevent, and it must not depend on the
 * UI having called `canAdvance` first.
 */
export function canWrite(state: CreatorAdvanceState): boolean {
  return (
    state.completed.includes("approve-permissions") &&
    state.approvals.includes("permission-widening")
  )
}

/** The first step that has not completed, or `undefined` when the run is done. */
export function firstIncompleteStep(
  completed: readonly CreatorStepId[]
): CreatorStepId | undefined {
  const done = new Set(completed)
  return CREATOR_STEP_IDS.find((id) => !done.has(id))
}
