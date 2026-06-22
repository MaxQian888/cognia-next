/**
 * Turn driver for the `/goal` subsystem (ADR-0013).
 *
 * Pure orchestrator — no IPC, no store mutations, no React. Given a
 * snapshot of the just-completed turn, it:
 *
 *   1. Persists the turn delta (turnsUsed + tokensUsed) via `updateGoal`.
 *   2. Appends a `turn_completed` event to the audit trail.
 *   3. Evaluates the seven exit conditions (`exit-conditions.ts`).
 *      - If one fires, transitions the goal status, logs the exit, and
 *        returns `{ kind: "exit", ... }`.
 *      - Otherwise, runs the judge LLM (`judge.ts`):
 *        - `kind: "decided"` + `done: true`  → exit via `judge_done`.
 *        - `kind: "decided"` + `done: false` → reset failure count, then
 *          return `{ kind: "continue", userMessage: ... }`.
 *        - `kind: "parse_error"` → bump failure count; if reaching
 *          `maxJudgeFailures`, exit via `judge_failed_too_many`,
 *          otherwise treat as "continue".
 *        - `kind: "aborted"` → return `{ kind: "aborted" }` (caller may
 *          have paused/stopped; do nothing).
 *
 * The decision is returned, not enacted. The chat hook is the only place
 * that owns `sendPrompt(...)`; turn-driver returns the continuation text
 * and lets the hook dispatch it. That keeps every code path in this file
 * deterministic and unit-testable without IPC mocks.
 *
 * **generationId guard:** every step that mutates the goal row first
 * reads it back and confirms the generation hasn't rotated. If it has —
 * meaning the user paused / stopped / updated mid-turn — we abort
 * silently and return `{ kind: "stale" }`.
 */

import type { LlmClient } from "@/lib/twin/distill/llm"
import type { AgentHookContext, LifecycleHookFirer } from "@/lib/claude/hooks/lifecycle-firer"
import type { UsageInfo } from "@/lib/claude/adapter"
import type { ExitReason, Goal, GoalStatus } from "@/types/goal"
import { isTerminalGoalStatus } from "@/types/goal"
import { appendGoalEvent, getGoal, updateGoal } from "@/lib/db/goals"
import { recordGoalUsage } from "@/lib/db/session-usage"
import { evaluateExitConditions } from "./exit-conditions"
import { evaluateGoal } from "./judge"
import { markSubgoalsComplete } from "./subgoals"
import { onGoalTerminal, toGoalHookPayload } from "./completion-linkage"
import { getPluginEventHooks } from "@/lib/plugin/messaging/hooks-system"
import {
  detectCompletionPromise,
  renderContinuationMessage,
  renderPromiseVerificationMessage,
  resolveJudgeSystemPrompt,
} from "./prompts"

/** Default `config.maxPromiseDenials` when the gate is armed without one. */
const DEFAULT_MAX_PROMISE_DENIALS = 3

export interface TurnCompleteInput {
  goalId: string
  /** Latest assistant message text (the response we want the judge to grade). */
  lastResponse: string
  /** Tokens consumed by *this* turn (input + output). 0 when unknown. */
  tokensDelta: number
  /** Full SDK usage for this turn when the caller has the result payload. */
  usage?: UsageInfo
  /**
   * `true` when this turn ended because the SDK hit the hard USD ceiling
   * (`SendOptions.maxBudgetUsd` → result subtype `error_max_budget_usd`). Drives
   * the terminal `cost_limited` exit. Default false.
   */
  budgetExceeded?: boolean
  /** Optional assistant message id for the audit payload. */
  modelMessageId?: string
  /** LLM client used to call the judge. */
  judgeClient: LlmClient
  /** Abort signal — set by the runtime when status mutates externally. */
  signal?: AbortSignal
  /**
   * Generation captured at turn start. The driver refuses to mutate the
   * goal if the row's `generationId` no longer matches — meaning the user
   * paused/stopped/updated mid-turn and the new generation owns the next
   * step.
   */
  capturedGenerationId: string
  /**
   * Lifecycle-hook firer used to bracket the judge LLM call (ADR-0040
   * follow-up). Renderer callers pass `defaultLifecycleFirer`; the CLI passes
   * its runner-backed firer. Omitted ⇒ the judge runs hook-free (no-op).
   */
  firer?: LifecycleHookFirer
  /** Hook context (session/cwd) for the judge firer. */
  hookContext?: AgentHookContext
}

export type TurnCompleteOutcome =
  | { kind: "no_goal" }
  | { kind: "stale"; reason: string }
  | { kind: "aborted" }
  | {
      kind: "exit"
      exit: ExitReason
      resultingStatus: GoalStatus
      reason: string
    }
  | { kind: "continue"; userMessage: string }

/**
 * Drive one turn completion forward. See module docstring for the state
 * machine.
 */
export async function handleTurnComplete(input: TurnCompleteInput): Promise<TurnCompleteOutcome> {
  const { goalId, lastResponse, tokensDelta, modelMessageId, judgeClient, signal } = input

  // Step 0 — load the row + sanity check.
  let goal = await getGoal(goalId)
  if (!goal) return { kind: "no_goal" }
  if (goal.generationId !== input.capturedGenerationId) {
    return { kind: "stale", reason: "generationId rotated since turn start" }
  }
  if (goal.status !== "active") {
    return { kind: "stale", reason: `goal status is ${goal.status}` }
  }

  if (signal?.aborted) {
    return { kind: "aborted" }
  }

  // Step 1 — record the turn delta on the row + audit trail.
  const newTurnsUsed = goal.turnsUsed + 1
  const newTokensUsed = goal.tokensUsed + Math.max(0, tokensDelta)
  await updateGoal(goalId, {
    turnsUsed: newTurnsUsed,
    tokensUsed: newTokensUsed,
  })
  await appendGoalEvent({
    goalId,
    kind: "turn_completed",
    payload: {
      kind: "turn_completed",
      turnNumber: newTurnsUsed,
      tokensDelta: Math.max(0, tokensDelta),
      modelMessageId,
    },
  })
  if (input.usage) {
    await recordGoalUsage({ goalId, turnId: newTurnsUsed, usage: input.usage }).catch(() => null)
  }
  void getPluginEventHooks().dispatchGoalProgress({
    ...toGoalHookPayload(goal),
    turnsUsed: newTurnsUsed,
    tokensUsed: newTokensUsed,
  })

  // Re-read the row with the updated counters in place. This is the
  // snapshot the exit evaluator and judge work against.
  goal = (await getGoal(goalId)) as Goal
  if (goal.generationId !== input.capturedGenerationId) {
    return { kind: "stale", reason: "generationId rotated after persist" }
  }

  // Step 2 — pre-judge exits (turn / budget / timeout). User-driven
  // exits (stopped / preempted) are handled by the slash command and
  // chat hook respectively before this function is ever called. These run
  // BEFORE the promise-verification branch, so a goal one turn from its cap
  // exits `turn_limited` even mid-verification (documented trade-off).
  const preJudge = evaluateExitConditions(goal, { costLimited: input.budgetExceeded })
  if (preJudge) {
    return commitExit(goalId, preJudge, input.capturedGenerationId)
  }

  if (signal?.aborted) return { kind: "aborted" }

  // Step 2.5 — completion-promise verification turn (anti false-completion).
  // When the previous turn ARMED the gate, this response is graded for the
  // exact `<promise>` token instead of being re-judged (no judge spend, and
  // a response that is just the token never gets judged "done" twice).
  const promiseText = goal.config.completionPromise?.trim() ?? ""
  if (promiseText && goal.awaitingPromise) {
    if (detectCompletionPromise(lastResponse, promiseText)) {
      await updateGoal(goalId, { awaitingPromise: false, promiseDenialCount: 0 })
      await appendGoalEvent({
        goalId,
        kind: "promise_confirmed",
        payload: { kind: "promise_confirmed", turnNumber: newTurnsUsed },
      })
      return commitExit(
        goalId,
        {
          exit: "judge_done",
          resultingStatus: "completed",
          reason: "completion promise confirmed",
        },
        input.capturedGenerationId
      )
    }
    // Denied — the model would not (or did not) emit the token. Clear the
    // flag and resume normal work: keeping it armed would pressure the model
    // to emit the token just to escape (exactly the reward-hack the gate
    // exists to prevent). The denial count persists across re-armed gates;
    // at the cap the judge has re-affirmed done that many times, so the
    // gate is overridden (audited) instead of wedging against maxTurns.
    const denialCount = (goal.promiseDenialCount ?? 0) + 1
    const cap = goal.config.maxPromiseDenials ?? DEFAULT_MAX_PROMISE_DENIALS
    const overridden = denialCount >= cap
    await updateGoal(goalId, { awaitingPromise: false, promiseDenialCount: denialCount })
    await appendGoalEvent({
      goalId,
      kind: "promise_denied",
      payload: { kind: "promise_denied", turnNumber: newTurnsUsed, denialCount, overridden },
    })
    if (overridden) {
      return commitExit(
        goalId,
        {
          exit: "judge_done",
          resultingStatus: "completed",
          reason: `judge confirmed done; promise gate overridden after ${denialCount} denial(s)`,
        },
        input.capturedGenerationId
      )
    }
    return { kind: "continue", userMessage: renderContinuationMessage(goal) }
  }

  // Step 3 — judge LLM call. Per-goal judge customization (ADR-0019 Phase 2)
  // threads through here; absent fields fall back to the judge's built-ins.
  const judgement = await evaluateGoal({
    goal,
    lastResponse,
    client: judgeClient,
    signal,
    temperature: goal.config.judgeTemperature,
    maxTokens: goal.config.judgeMaxTokens,
    system: resolveJudgeSystemPrompt(goal),
    firer: input.firer,
    hookContext: input.hookContext ?? { agentId: "goal-judge", sessionId: goalId },
  })

  if (judgement.kind === "aborted") {
    return { kind: "aborted" }
  }

  // Refresh after the await — caller may have paused mid-judge.
  goal = (await getGoal(goalId)) as Goal
  if (!goal || goal.generationId !== input.capturedGenerationId) {
    return { kind: "stale", reason: "generationId rotated during judge" }
  }
  if (goal.status !== "active") {
    return { kind: "stale", reason: `goal status changed to ${goal.status} during judge` }
  }

  if (judgement.kind === "parse_error") {
    // Bump failure count. Fail-OPEN: if we haven't hit the cap, continue
    // the loop assuming `done=false`. If we have, exit via
    // judge_failed_too_many (paused, not terminal).
    const newFailureCount = goal.judgeFailureCount + 1
    await updateGoal(goalId, { judgeFailureCount: newFailureCount })
    await appendGoalEvent({
      goalId,
      kind: "judge_parse_failed",
      payload: {
        kind: "judge_parse_failed",
        raw: judgement.raw,
        failureCount: newFailureCount,
      },
    })
    if (newFailureCount >= goal.config.maxJudgeFailures) {
      const exit = evaluateExitConditions((await getGoal(goalId)) as Goal)
      if (exit) return commitExit(goalId, exit, input.capturedGenerationId)
    }
    // Otherwise: keep looping. The model's last response wasn't formally
    // judged "done", and we don't want to wedge — so we send the standard
    // continuation prompt.
    return { kind: "continue", userMessage: renderContinuationMessage(goal) }
  }

  // judgement.kind === "decided"
  await appendGoalEvent({
    goalId,
    kind: "judge_evaluated",
    payload: {
      kind: "judge_evaluated",
      done: judgement.done,
      reason: judgement.reason,
      judgeTokens: 0,
    },
  })
  // Reset failure count on a successful parse, regardless of done.
  await updateGoal(goalId, { judgeFailureCount: 0 })

  // Subgoal progress (subgoal decomposition): if the goal has a checklist and
  // the judge reported completed steps, mark them done. Best-effort + monotonic
  // — never blocks the done/reason verdict and stays a no-op without subgoals.
  if (goal.subgoals && goal.subgoals.length > 0 && judgement.completedSubgoals?.length) {
    const nextSubgoals = markSubgoalsComplete(goal.subgoals, judgement.completedSubgoals)
    if (nextSubgoals !== goal.subgoals) {
      await updateGoal(goalId, { subgoals: nextSubgoals })
    }
  }

  const postJudge = evaluateExitConditions((await getGoal(goalId)) as Goal, {
    judgeDecision: { done: judgement.done, reason: judgement.reason },
  })
  if (postJudge) {
    // Completion-promise gate: a judge `done=true` ARMS a verification turn
    // instead of exiting (when configured). Short-circuit when this very
    // response already carries the token — no extra turn needed.
    if (postJudge.exit === "judge_done" && promiseText) {
      if (detectCompletionPromise(lastResponse, promiseText)) {
        await updateGoal(goalId, { awaitingPromise: false, promiseDenialCount: 0 })
        await appendGoalEvent({
          goalId,
          kind: "promise_confirmed",
          payload: { kind: "promise_confirmed", turnNumber: newTurnsUsed },
        })
        return commitExit(
          goalId,
          {
            exit: "judge_done",
            resultingStatus: "completed",
            reason: "completion promise confirmed",
          },
          input.capturedGenerationId
        )
      }
      const fresh = await getGoal(goalId)
      if (!fresh || fresh.generationId !== input.capturedGenerationId) {
        return { kind: "stale", reason: "generationId rotated before promise arm" }
      }
      await updateGoal(goalId, { awaitingPromise: true })
      await appendGoalEvent({
        goalId,
        kind: "promise_requested",
        payload: { kind: "promise_requested", turnNumber: newTurnsUsed },
      })
      return { kind: "continue", userMessage: renderPromiseVerificationMessage(goal) }
    }
    return commitExit(goalId, postJudge, input.capturedGenerationId)
  }
  return { kind: "continue", userMessage: renderContinuationMessage(goal) }
}

/**
 * Apply an exit decision: mutate the row's status + endedAt, log
 * `exit_triggered`. Returns the same shape as `handleTurnComplete`'s
 * exit branch.
 */
async function commitExit(
  goalId: string,
  decision: { exit: ExitReason; resultingStatus: GoalStatus; reason: string },
  capturedGenerationId: string
): Promise<TurnCompleteOutcome> {
  const fresh = await getGoal(goalId)
  if (!fresh || fresh.generationId !== capturedGenerationId) {
    return { kind: "stale", reason: "generationId rotated before exit commit" }
  }
  await updateGoal(goalId, { status: decision.resultingStatus })
  await appendGoalEvent({
    goalId,
    kind: "exit_triggered",
    payload: {
      kind: "exit_triggered",
      exit: decision.exit,
      reason: decision.reason,
    },
  })
  // Completion linkage (ADR-0019 Phase 2): notify + fire goal-completed
  // workflows on a terminal exit. judge_failed_too_many lands as `paused`
  // (non-terminal) and is deliberately skipped. Best-effort, never throws.
  if (isTerminalGoalStatus(decision.resultingStatus)) {
    void onGoalTerminal({ ...fresh, status: decision.resultingStatus })
  }
  return {
    kind: "exit",
    exit: decision.exit,
    resultingStatus: decision.resultingStatus,
    reason: decision.reason,
  }
}
