/**
 * Generate a goal's subgoal checklist on THIS host, with the outcome spelled
 * out for a UI.
 *
 * `GoalRuntime.generateSubgoals` takes a ready `LlmClient` and fails OPEN (an
 * unparseable answer, a provider error or a PII-gate refusal leaves the prior
 * checklist in place). Two callers need the same client resolution around it
 * and the same reading of what happened: the Subgoals tab on the host, and the
 * desktop's `goal_subgoals_generate` arm a paired phone reaches. Both resolve
 * the model the tab always has (the goal's conversation, the host's settings,
 * feature id `goal-subgoals`), and both answer:
 *
 * - `generated`   — a fresh checklist replaced the old one.
 * - `empty`       — the model produced nothing usable; any prior checklist is
 *                   kept. Retryable.
 * - `unavailable` — no model with a usable API key resolves on this host.
 *                   Retrying cannot help until the user configures one.
 * - `missing`     — the goal does not exist (deleted under the caller).
 *
 * The plugin API and the workflow node keep their own wrappers: they throw on
 * `unavailable` and attribute the call to a different ledger surface.
 */

import type { AppSettings } from "@cognia/agent-config-types"

import { buildRendererLlmClient } from "@/lib/ai/renderer-llm-client"
import { getGoal } from "@/lib/db/goals"
import { getSession } from "@/lib/db/sessions"
import { getGoalRuntime } from "@/lib/goal/runtime"
import type { Goal } from "@/types/goal"

export type GoalSubgoalsGenerateResult =
  | { outcome: "generated" | "empty" | "unavailable"; goal: Goal }
  | { outcome: "missing"; goal: null }

/**
 * What `goal_subgoals_generate` answers a paired device: the outcome above, or
 * `running` when the model was still answering when the desktop had to reply.
 * A running generation still finishes on the desktop, and its checklist
 * reaches the device on the goal row's sync.
 */
export type GoalSubgoalsGenerateWireResult = GoalSubgoalsGenerateResult | { outcome: "running" }

export async function generateGoalSubgoals(
  goalId: string,
  appSettings: AppSettings | null | undefined
): Promise<GoalSubgoalsGenerateResult> {
  const current = await getGoal(goalId)
  if (!current) return { outcome: "missing", goal: null }
  const session = await getSession(current.sessionId)
  const client = buildRendererLlmClient({ session, appSettings, featureId: "goal-subgoals" })
  if (!client) return { outcome: "unavailable", goal: current }
  const updated = await getGoalRuntime().generateSubgoals(goalId, client)
  // Deleted while the model was answering.
  if (!updated) return { outcome: "missing", goal: null }
  // The runtime stamps `subgoalsGeneratedAt` only when it wrote a checklist;
  // an unchanged stamp is its fail-OPEN "kept what was there".
  const generated =
    updated.subgoalsGeneratedAt !== undefined &&
    updated.subgoalsGeneratedAt !== current.subgoalsGeneratedAt
  return { outcome: generated ? "generated" : "empty", goal: updated }
}
