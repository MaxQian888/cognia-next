/**
 * Seven exit conditions for an active `/goal`. Pure function — given the
 * current `Goal` row and a per-call snapshot of dynamic flags, returns
 * either an `ExitDecision` (with the reason and the resulting status)
 * or `null` (continue looping).
 *
 * Order matters. The cases are evaluated top-down and the first match
 * wins; this priority order is the public contract:
 *
 *   1. user_stopped         — explicit `/goal stop|cancel|clear`
 *   2. preempted            — user typed a non-slash message mid-loop
 *   3. turn_limited         — turnsUsed >= config.maxTurns
 *   4. budget_limited       — tokensUsed >= config.maxTokens
 *   5. timed_out            — Date.now() - createdAt >= config.timeoutMs
 *   6. judge_failed_too_many — judgeFailureCount >= config.maxJudgeFailures
 *   7. judge_done           — caller's judge call returned `done = true`
 *
 * The pause-vs-terminal mapping comes from `statusForExit()` in
 * `types/goal.ts`. Two of the seven (`judge_failed_too_many`) land the
 * goal in `paused` so the user can recover after a transient flaky
 * judge; the other five are terminal.
 */

import type { ExitReason, Goal, GoalStatus } from "@/types/goal"
import { statusForExit } from "@/types/goal"

/**
 * Discriminated outcome of `evaluateExitConditions`. `null` means the
 * loop should continue.
 */
export interface ExitDecision {
  exit: ExitReason
  /** Resulting status (terminal for most exits, `paused` for judge_failed_too_many). */
  resultingStatus: GoalStatus
  /** Human-readable rationale stamped into the `exit_triggered` event payload. */
  reason: string
}

/**
 * Per-call dynamic inputs that don't live on the `Goal` row.
 *
 * `userStopRequested` and `userPreempted` are owned by the slash-command
 * dispatcher and the chat composer respectively — neither belongs on the
 * persistent goal row.
 *
 * `judgeDecision` is the verdict from `evaluateGoal`, normalised to a
 * boolean. The driver only forwards `done=true` results into the exit
 * machinery; `done=false` continues the loop without ever reaching this
 * function. Pass `undefined` when no judge call ran this turn.
 *
 * `now` is injectable so tests can pin a deterministic clock.
 */
export interface ExitConditionsContext {
  userStopRequested?: boolean
  userPreempted?: boolean
  judgeDecision?: { done: boolean; reason: string }
  now?: number
}

/** Pure evaluator — see module docstring. */
export function evaluateExitConditions(
  goal: Goal,
  ctx: ExitConditionsContext = {}
): ExitDecision | null {
  if (ctx.userStopRequested) {
    return decision("user_stopped", "user invoked /goal stop")
  }
  if (ctx.userPreempted) {
    return decision("preempted", "user sent a fresh message mid-loop")
  }
  if (goal.turnsUsed >= goal.config.maxTurns) {
    return decision(
      "turn_limited",
      `turn budget exhausted (${goal.turnsUsed}/${goal.config.maxTurns})`
    )
  }
  if (goal.tokensUsed >= goal.config.maxTokens) {
    return decision(
      "budget_limited",
      `token budget exhausted (${goal.tokensUsed}/${goal.config.maxTokens})`
    )
  }
  const now = ctx.now ?? Date.now()
  const elapsed = now - goal.createdAt
  if (elapsed >= goal.config.timeoutMs) {
    return decision("timed_out", `wall-clock timeout reached after ${Math.round(elapsed / 1000)}s`)
  }
  if (goal.judgeFailureCount >= goal.config.maxJudgeFailures) {
    return decision(
      "judge_failed_too_many",
      `judge JSON parse failed ${goal.judgeFailureCount} times in a row`
    )
  }
  if (ctx.judgeDecision?.done) {
    return decision("judge_done", ctx.judgeDecision.reason || "judge confirmed objective satisfied")
  }
  return null
}

function decision(exit: ExitReason, reason: string): ExitDecision {
  return {
    exit,
    resultingStatus: statusForExit(exit),
    reason,
  }
}
