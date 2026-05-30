/**
 * Goal completion linkage (ADR-0019 Phase 2 — group 4).
 *
 * Fired once from every terminal transition (judge_done / turn / budget /
 * timeout / user stop / preempt) so the side effects are consistent across
 * exit paths:
 *
 *   (a) a desktop notification (reuses `lib/tauri/notification` — a no-op
 *       outside Tauri);
 *   (b) a `trigger.goal.completed` workflow fan-out (mirrors
 *       `dispatchChatMessageTriggers` in `lib/db/messages.ts`).
 *
 * Best-effort and never throws into the caller — a notification or workflow
 * failure must not break the goal state machine. The workflow payload carries
 * only `safeObjective` (the redacted text) — never `rawObjective`.
 */

import type { Goal } from "@/types/goal"
import type { GoalHookPayload } from "@/types/plugin/plugin-hooks"
import { getPluginEventHooks } from "@/lib/plugin/messaging/hooks-system"

/**
 * Project a `Goal` row down to the redacted snapshot handed to plugin goal
 * hooks. Carries ONLY `safeObjective` — never `rawObjective` / the redaction
 * map — so a hook listener can't observe stripped PII.
 */
export function toGoalHookPayload(goal: Goal): GoalHookPayload {
  return {
    goalId: goal.id,
    sessionId: goal.sessionId,
    characterId: goal.characterId,
    status: goal.status,
    safeObjective: goal.safeObjective,
    turnsUsed: goal.turnsUsed,
    tokensUsed: goal.tokensUsed,
  }
}

/** Run notification + workflow fan-out for a goal that just reached a terminal status. */
export async function onGoalTerminal(goal: Goal): Promise<void> {
  // Plugin goal hook — redacted payload, best-effort, alongside the existing
  // notification + workflow fan-out.
  void getPluginEventHooks().dispatchGoalComplete(toGoalHookPayload(goal))
  await Promise.all([notifyGoalTerminal(goal), dispatchGoalCompletedTriggers(goal)])
}

async function notifyGoalTerminal(goal: Goal): Promise<void> {
  try {
    const { notify } = await import("@/lib/tauri/notification")
    await notify({ title: `Cognia · goal ${goal.status}`, body: goal.safeObjective })
  } catch {
    // Best-effort — notification permission / transport issues must not throw.
  }
}

async function dispatchGoalCompletedTriggers(goal: Goal): Promise<void> {
  try {
    // Lazy-load the workflow runtime so the goal subsystem stays cheap to
    // import (matches the dispatchChatMessageTriggers pattern).
    const [{ dispatchTrigger }, { findMatchingWorkflows }] = await Promise.all([
      import("@/lib/workflow/runtime/trigger-bridge"),
      import("@/lib/workflow/runtime/trigger-subscriptions"),
    ])
    const matches = findMatchingWorkflows("trigger.goal.completed", {
      characterId: goal.characterId,
      sessionId: goal.sessionId,
      goalId: goal.id,
      status: goal.status,
    })
    if (matches.length === 0) return

    const originAt = Date.now()
    await Promise.all(
      matches.map((match) =>
        dispatchTrigger({
          workflowId: match.workflowId,
          kind: "trigger.goal.completed",
          payload: {
            goalId: goal.id,
            status: goal.status,
            // Redacted objective only — never the raw text (PII red-line).
            safeObjective: goal.safeObjective,
            turnsUsed: goal.turnsUsed,
            tokensUsed: goal.tokensUsed,
          },
          originAt,
          binding: { sessionId: goal.sessionId, characterId: goal.characterId, goalId: goal.id },
        }).catch(() => {
          // Per-match isolation — one bad workflow can't block the others.
        })
      )
    )
  } catch {
    // Workflow runtime unavailable (e.g. web-only build path) — best-effort.
  }
}
