/**
 * Schema for the lead's stage-checkpoint re-planning decision (adaptive
 * orchestration). Between waves of a team run, the lead model reviews the
 * just-completed results and returns one of these decisions; `dispatchStructured`
 * validates the model's fenced-JSON output against it.
 *
 * Index/title-free: `dependsOn` may reference either an existing task id or the
 * title of another injected task in the same checkpoint — the checkpoint
 * resolves titles → ids when materializing.
 */
import { z } from "zod"

export const replanNewTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  expectedOutput: z.string().optional(),
  /** Teammate id to prefer for this task; dropped if it is not on the roster. */
  assignedTo: z.string().optional(),
  /** Existing task ids or sibling new-task titles this task depends on. */
  dependsOn: z.array(z.string()).default([]),
})

export type ReplanNewTask = z.infer<typeof replanNewTaskSchema>

export const replanNewMemberSchema = z.object({
  /** Display name for the recruited teammate. */
  name: z.string().min(1),
  /**
   * Employee Digital Twin id to bind (from the run's `availableTwins`). Dropped
   * when it is not a known twin — a recruit without a twin is still a valid
   * plain teammate. See `replan-checkpoint.ts`.
   */
  twinId: z.string().optional(),
  specialization: z.string().optional(),
  description: z.string().optional(),
})

export type ReplanNewMember = z.infer<typeof replanNewMemberSchema>

export const replanDecisionSchema = z.object({
  action: z.enum(["continue", "inject", "cancel", "reorder", "finish", "recruit"]),
  /** One-line rationale, surfaced in the activity panel + approval gate. */
  reasoning: z.string().min(1),
  /** New tasks to add to the remaining plan (only for action="inject"). */
  newTasks: z.array(replanNewTaskSchema).default([]),
  /**
   * Digital employees (twins) to recruit as fresh members (action="recruit").
   * Materialized + registered in the pool before the next wave; may also be set
   * alongside "inject" so injected tasks can target a freshly recruited member.
   */
  newMembers: z.array(replanNewMemberSchema).default([]),
  /** Remaining task ids to cancel/skip (only for action="cancel"). */
  cancelTaskIds: z.array(z.string()).default([]),
  /** A permutation of the remaining task ids (only for action="reorder"). */
  reorderTaskIds: z.array(z.string()).default([]),
})

export type ReplanDecision = z.infer<typeof replanDecisionSchema>

/** Human-readable schema hint appended to the lead prompt for the model. */
export const REPLAN_SCHEMA_HINT = [
  '{ "action": "continue" | "inject" | "cancel" | "reorder" | "finish" | "recruit",',
  '  "reasoning": string,',
  '  "newTasks": [{ "title": string, "description": string, "expectedOutput"?: string, "assignedTo"?: string, "dependsOn"?: string[] }],',
  '  "newMembers": [{ "name": string, "twinId"?: string, "specialization"?: string, "description"?: string }],',
  '  "cancelTaskIds": string[],',
  '  "reorderTaskIds": string[] }',
].join("\n")

/** The deterministic fail-open decision: proceed with the plan unchanged. */
export function continueDecision(reasoning = "No change to the plan."): ReplanDecision {
  return {
    action: "continue",
    reasoning,
    newTasks: [],
    newMembers: [],
    cancelTaskIds: [],
    reorderTaskIds: [],
  }
}
