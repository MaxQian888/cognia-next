/**
 * Human acceptance resolution for the /goal acceptance gate
 * (`GoalConfig.requireAcceptance`, ADR-0019 extension).
 *
 * When the gate is on, a judge-verdict "completed" parks the goal as
 * `paused` + `awaitingAcceptance` (see `turn-driver.ts` `commitExit`).
 * This module is the only way out of that state:
 *
 *   - accept          → `completed` (+ endedAt via updateGoal's terminal
 *                       back-fill, generationId rotation, completion linkage)
 *   - request changes → `active` (generationId rotation so a stale in-flight
 *                       callback can't write into the resumed generation)
 *
 * Both paths clear `awaitingAcceptance` and log `acceptance_resolved`.
 */

import { getGoal, updateGoal, appendGoalEvent } from "@/lib/db/goals"
import { onGoalTerminal } from "./completion-linkage"
import type { Goal } from "@/types/goal"

/**
 * Resolve a pending acceptance. No-op (returns the current row) when the
 * goal is missing or not awaiting acceptance — callers must not fabricate a
 * completion for a goal the gate never parked.
 */
export async function resolveGoalAcceptance(
  goalId: string,
  accepted: boolean
): Promise<Goal | null> {
  const current = await getGoal(goalId)
  if (!current) return null
  if (current.status !== "paused" || current.awaitingAcceptance !== true) return current

  await updateGoal(goalId, {
    status: accepted ? "completed" : "active",
    awaitingAcceptance: false,
    // Rotate the race guard: any stale in-flight turn callback captured the
    // old generation and must not write into the resolved one.
    generationId: crypto.randomUUID(),
  })
  await appendGoalEvent({
    goalId,
    kind: "acceptance_resolved",
    payload: { kind: "acceptance_resolved", accepted },
  })

  const updated = (await getGoal(goalId)) ?? null
  if (accepted && updated) {
    // Completion linkage (notifications + goal-completed workflows) fires on
    // the real terminal transition, same as commitExit's direct path.
    void onGoalTerminal(updated)
  }
  return updated
}
