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
import { dispatchCompletionFanout } from "@/lib/runtime/completion-linkage-core"

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
  await Promise.all([
    notifyGoalTerminal(goal),
    dispatchGoalCompletedTriggers(goal),
    emitGoalCompletedSchedulerEvent(goal),
  ])
}

/**
 * Emit a `goal:completed` scheduler event so event-triggered scheduled tasks
 * (and forward chains keyed on it) can react when a goal reaches a terminal
 * status. Carries the redacted objective only — never the raw text. Lazy
 * import keeps the goal subsystem cheap; best-effort (never throws).
 */
async function emitGoalCompletedSchedulerEvent(goal: Goal): Promise<void> {
  try {
    const { emitSchedulerEvent } = await import("@/lib/scheduler/event-integration")
    await emitSchedulerEvent(
      "goal:completed",
      {
        goalId: goal.id,
        sessionId: goal.sessionId,
        status: goal.status,
        safeObjective: goal.safeObjective,
        turnsUsed: goal.turnsUsed,
        tokensUsed: goal.tokensUsed,
      },
      "goal"
    )
  } catch {
    // Scheduler unavailable (e.g. web-only path) — best-effort.
  }
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
  // Shared fan-out mechanics (lazy runtime load, match → dispatch with
  // per-match isolation, outer best-effort) live in the core module. The
  // payload carries the pre-redacted `safeObjective` only — never the raw
  // text — so no additional PII gate is needed here.
  await dispatchCompletionFanout({
    kind: "trigger.goal.completed",
    match: {
      characterId: goal.characterId,
      sessionId: goal.sessionId,
      goalId: goal.id,
      status: goal.status,
    },
    payload: {
      goalId: goal.id,
      status: goal.status,
      safeObjective: goal.safeObjective,
      turnsUsed: goal.turnsUsed,
      tokensUsed: goal.tokensUsed,
    },
    binding: { sessionId: goal.sessionId, characterId: goal.characterId, goalId: goal.id },
  })
}
