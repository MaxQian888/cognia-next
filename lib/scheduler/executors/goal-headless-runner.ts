/**
 * Headless `/goal` loop driver for the scheduler.
 *
 * The interactive goal loop is pumped by the chat hook
 * (`hooks/chat/use-claude-chat.ts`): after each turn it builds a judge client,
 * calls `handleTurnComplete`, and dispatches the returned continuation as the
 * next user message. A scheduled goal has no chat hook, so this module
 * reproduces that loop using the same primitives:
 *
 *   1. Resolve SendOptions for the session WITH `activeGoal` so build-options
 *      injects the goal system section.
 *   2. Run one turn headlessly via `runAndCaptureAssistantReply` (captures the
 *      assistant text + per-turn usage).
 *   3. Feed the result to `handleTurnComplete` (the pure turn-driver), which
 *      persists the delta, evaluates exit conditions, runs the judge, and
 *      returns continue / exit / aborted / stale.
 *   4. On `continue`, send the returned continuation message as the next turn.
 *
 * Bounding: `handleTurnComplete` enforces the goal's own exit conditions
 * (turns / budget / timeout / judge), so the loop terminates on its own. A
 * defensive hard cap guards against a wedged generation that never reaches a
 * terminal status.
 *
 * The first user message is the goal's `safeObjective` — the redacted text, so
 * no raw PII leaves the device in the headless (un-reviewed) path. Subsequent
 * turns use the turn-driver's generated continuation messages.
 */

import type { AppSettings } from "@cognia/agent-config-types"
import { isTerminalGoalStatus, type GoalStatus } from "@/types/goal"
import { getGoal } from "@/lib/db/goals"
import { getSession } from "@/lib/db/sessions"
import { resolveSendOptions } from "@/lib/claude/build-options"
import { runAndCaptureAssistantReply, RunAndCaptureError } from "@/lib/claude/run-and-capture"
import { buildGoalJudgeClient } from "@/lib/goal/judge-client"
import { handleTurnComplete } from "@/lib/goal/turn-driver"
import { loggers } from "@cognia/logging"

const log = loggers.scheduler

export interface RunGoalLoopInput {
  sessionId: string
  goalId: string
  appSettings: AppSettings | null
  signal: AbortSignal
  /** Per-turn capture timeout (ms). Defaults to the run-and-capture default. */
  perTurnTimeoutMs?: number
}

export interface RunGoalLoopResult {
  status: GoalStatus
  turns: number
  lastResponse?: string
  error?: string
}

export async function runGoalLoopHeadless(input: RunGoalLoopInput): Promise<RunGoalLoopResult> {
  const { sessionId, goalId, appSettings, signal } = input

  const session = await getSession(sessionId)
  if (!session) {
    return { status: "stopped", turns: 0, error: `Session not found: ${sessionId}` }
  }

  const judgeClient = buildGoalJudgeClient(session, appSettings)
  if (!judgeClient) {
    return {
      status: "paused",
      turns: 0,
      error: "Goal judge client unavailable (legacy env-key setup cannot judge headlessly)",
    }
  }

  // First turn sends the redacted objective; later turns send the turn-driver's
  // continuation message.
  let nextPrompt: string | null = null
  let turns = 0
  let lastResponse: string | undefined

  // Defensive hard cap: maxTurns (the real bound is inside handleTurnComplete)
  // plus a small buffer for parse-error continues.
  const initial = await getGoal(goalId)
  if (!initial) return { status: "stopped", turns: 0, error: `Goal not found: ${goalId}` }
  const hardCap = (initial.config.maxTurns ?? 20) + 5

  while (turns < hardCap) {
    if (signal.aborted) {
      return { status: "paused", turns, lastResponse, error: "aborted" }
    }

    const goal = await getGoal(goalId)
    if (!goal) return { status: "stopped", turns, lastResponse, error: "goal removed mid-run" }
    if (isTerminalGoalStatus(goal.status)) {
      return { status: goal.status, turns, lastResponse }
    }
    if (goal.status !== "active") {
      // Paused externally — stop driving; the run is no longer ours.
      return { status: goal.status, turns, lastResponse }
    }

    const prompt = nextPrompt ?? goal.safeObjective
    const capturedGenerationId = goal.generationId

    let resolved
    try {
      resolved = await resolveSendOptions({ session, appSettings, activeGoal: goal })
    } catch (err) {
      return {
        status: goal.status,
        turns,
        lastResponse,
        error: err instanceof Error ? err.message : String(err),
      }
    }

    let captureText = ""
    let tokensDelta = 0
    let budgetExceeded = false
    let captureUsage: Awaited<ReturnType<typeof runAndCaptureAssistantReply>>["usage"]
    try {
      const capture = await runAndCaptureAssistantReply(sessionId, prompt, resolved, {
        signal,
        ...(typeof input.perTurnTimeoutMs === "number"
          ? { timeoutMs: input.perTurnTimeoutMs }
          : {}),
        execution: { kind: "goal", label: `Goal ${goalId.slice(0, 8)}`, taskId: goalId },
      })
      captureText = capture.text
      lastResponse = capture.text
      captureUsage = capture.usage
      tokensDelta = (capture.usage?.inputTokens ?? 0) + (capture.usage?.outputTokens ?? 0)
      budgetExceeded = capture.resultSubtype === "error_max_budget_usd"
    } catch (err) {
      if (err instanceof RunAndCaptureError && err.code === "aborted") {
        return { status: "paused", turns, lastResponse, error: "aborted" }
      }
      // A turn-level failure pauses the goal so the schedule's retry/notify
      // policy can decide what to do, rather than silently looping.
      return {
        status: goal.status,
        turns,
        lastResponse,
        error: err instanceof Error ? err.message : String(err),
      }
    }

    turns += 1

    const outcome = await handleTurnComplete({
      goalId,
      lastResponse: captureText,
      tokensDelta,
      usage: captureUsage,
      budgetExceeded,
      judgeClient,
      signal,
      capturedGenerationId,
    })

    log.debug("Scheduler goal turn complete", {
      goalId,
      turns,
      outcome: outcome.kind,
    })

    switch (outcome.kind) {
      case "continue":
        nextPrompt = outcome.userMessage
        break
      case "exit":
        return { status: outcome.resultingStatus, turns, lastResponse }
      case "aborted":
        return { status: "paused", turns, lastResponse, error: "aborted" }
      case "stale":
        return { status: "stopped", turns, lastResponse, error: outcome.reason }
      case "no_goal":
        return { status: "stopped", turns, lastResponse, error: "goal removed mid-run" }
    }
  }

  // Hard-cap fallthrough — should be unreachable given the in-driver bounds.
  const final = await getGoal(goalId)
  return {
    status: final?.status ?? "stopped",
    turns,
    lastResponse,
    error: "goal loop hit defensive hard cap",
  }
}
