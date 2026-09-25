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
 *      injects the goal system section, and with the session's owning
 *      workspace as `activeProject` so the turn gets that workspace's
 *      instructions, roots, knowledge and confinement.
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
 *
 * By default nobody is watching these turns (the scheduler). A tool's
 * permission request is answered at once by the unattended responder: denied,
 * with the model told why. The turn driver then pauses the goal with exit
 * `needs_approval` rather than continue into the same wall, and the result
 * names the denied tools. A caller with a human in the loop supplies its own
 * responder (`onPermissionRequest`; the IM driver asks in the conversation).
 * Its answers are decisions, so only the requests it hands back to the
 * unattended responder, the ones nobody could answer, pause the goal.
 */

import type {
  AppSettings,
  PermissionRequestEvent,
  SendContent,
  SendOptions,
} from "@cognia/agent-config-types"
import { isTerminalGoalStatus, type ExitReason, type Goal, type GoalStatus } from "@/types/goal"
import { getGoal } from "@/lib/db/goals"
import { getSession } from "@/lib/db/sessions"
import { resolveSendOptions } from "@/lib/claude/build-options"
import {
  runAndCaptureAssistantReply,
  RunAndCaptureError,
  type CapturePermissionDecision,
  type RunAndCaptureOptions,
  type RunAndCaptureResult,
} from "@/lib/claude/run-and-capture"
import { buildGoalJudgeClient } from "@/lib/goal/judge-client"
import { handleTurnComplete } from "@/lib/goal/turn-driver"
import { gateContinuation } from "@/lib/goal/pacing"
import {
  createUnattendedPermissionResponder,
  needsApprovalSummary,
  type UnattendedPermissionDenial,
  type UnattendedPermissionResponder,
} from "@/lib/claude/unattended-permission-responder"
import { loadOwningWorkspace } from "./owning-workspace"
import { loggers } from "@cognia/logging"

const log = loggers.scheduler

/**
 * A caller's answer to a goal turn's tool permission request. `unattended` is
 * the run's default responder: hand it a request nobody could decide and it
 * denies it the unattended way and records it for `needsApproval`.
 */
export type GoalPermissionResponder = (
  request: PermissionRequestEvent,
  unattended: UnattendedPermissionResponder["onPermissionRequest"]
) => CapturePermissionDecision | Promise<CapturePermissionDecision>

export interface RunGoalLoopInput {
  sessionId: string
  goalId: string
  appSettings: AppSettings | null
  signal: AbortSignal
  /** Per-turn capture timeout (ms). Defaults to the run-and-capture default. */
  perTurnTimeoutMs?: number
  /**
   * Called after each completed turn with the captured assistant text. The
   * scheduler leaves it unset (no per-turn delivery); the connector driver
   * uses it to post every turn back to the IM conversation.
   */
  onTurn?: (text: string, turnIndex: number, goal: Goal) => void | Promise<void>
  /**
   * Model-send seam for unreviewed runtimes. Connector callers inject their
   * PII-gated sender; the scheduler keeps the existing capture implementation.
   */
  sendTurn?: (
    sessionId: string,
    prompt: SendContent,
    options: SendOptions | undefined,
    captureOptions: RunAndCaptureOptions
  ) => Promise<RunAndCaptureResult>
  /**
   * Opt-in continuation pacing. OFF by default so the scheduler path is
   * byte-for-byte unchanged (a cron firing IS the scheduled goal's pacing).
   * The connector driver turns it on so IM goals honor manualContinue /
   * quiet-hours / min-interval between turns, deferring or holding as the
   * pacing gate decides.
   */
  pacing?: {
    enabled: boolean
    /** Clock source (defaults to `Date.now`). */
    now?: () => number
    /** Sleep primitive (defaults to `setTimeout`). */
    sleep?: (ms: number) => Promise<void>
    /** Max single sleep before re-checking status + re-evaluating the gate. */
    maxSleepMs?: number
  }
  /**
   * Which workspace each turn resolves against. `"owning"` (the default) is
   * the session's own workspace (ADR-0144), never the one open in the UI: its
   * custom instructions, CLAUDE.md/AGENTS.md from every root, project
   * knowledge, additional directories and workspace confinement, the same as
   * a scheduled chat turn. `"none"` resolves with no workspace, as connector
   * turns do (see `activeProject` in `lib/claude/build-options.ts`); the
   * connector driver passes it so an IM goal matches the rest of its
   * conversation.
   */
  workspace?: "owning" | "none"
  /**
   * Who answers each turn's tool permission requests. Unset (the scheduler),
   * the unattended responder denies every request at once, and a turn with a
   * denial pauses the goal `needs_approval`. A caller with a human in the loop
   * supplies its own: the connector driver projects an IM approval card. What
   * it returns is a decision, so a human's Deny reaches the model like any
   * other tool result and the goal carries on.
   *
   * A request no human could decide (the card was never shown, or expired
   * untapped) goes to the `unattended` argument instead. Those denials, and
   * only those, feed `needsApproval` and the `needs_approval` pause, since
   * the next turn would find nobody there either.
   */
  onPermissionRequest?: GoalPermissionResponder
}

export interface RunGoalLoopResult {
  status: GoalStatus
  turns: number
  lastResponse?: string
  error?: string
  /** The goal's exit, when the loop ended on one (not on a stop, abort or error). */
  exit?: ExitReason
  /**
   * Every tool request the run denied for want of an approver, in arrival
   * order: with the default responder every request that asked, with a
   * caller's `onPermissionRequest` only those it handed to `unattended`. A
   * human's Deny is never listed. Present only when there was one. The goal is
   * then `paused` with exit `needs_approval`, unless the turn ended it another
   * way (the judge found it done, a limit fired).
   */
  needsApproval?: UnattendedPermissionDenial[]
}

export async function runGoalLoopHeadless(input: RunGoalLoopInput): Promise<RunGoalLoopResult> {
  // Answer each permission request now, rather than leave it to whichever
  // listener the shell has: the desktop's silent "session not open" deny, or
  // the headless brain's hang until the capture timeout. With no caller
  // responder nobody is watching, so every request gets a recorded denial.
  // With one, only the requests it hands back are recorded.
  const permissions = createUnattendedPermissionResponder("goal")
  const callerResponder = input.onPermissionRequest
  const onPermissionRequest: RunAndCaptureOptions["onPermissionRequest"] = callerResponder
    ? (request) => callerResponder(request, permissions.onPermissionRequest)
    : permissions.onPermissionRequest
  const result = await driveGoalLoop(input, permissions, onPermissionRequest)
  return permissions.needsApproval()
    ? { ...result, needsApproval: [...permissions.denials] }
    : result
}

async function driveGoalLoop(
  input: RunGoalLoopInput,
  permissions: UnattendedPermissionResponder,
  onPermissionRequest: RunAndCaptureOptions["onPermissionRequest"]
): Promise<RunGoalLoopResult> {
  const { sessionId, goalId, appSettings, signal } = input
  const sendTurn = input.sendTurn ?? runAndCaptureAssistantReply

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

  // Pacing state (only consulted when `pacing.enabled`).
  const nowFn = input.pacing?.now ?? Date.now
  const sleepFn =
    input.pacing?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const maxSleepMs = input.pacing?.maxSleepMs ?? 60_000
  let lastContinuationAt: number | undefined

  // Defensive hard cap: maxTurns (the real bound is inside handleTurnComplete)
  // plus a small buffer for parse-error continues.
  const initial = await getGoal(goalId)
  if (!initial) return { status: "stopped", turns: 0, error: `Goal not found: ${goalId}` }
  const hardCap = (initial.config.maxTurns ?? 20) + 5

  // The session's own workspace: a scheduled goal's session carries its task's
  // `projectId` (`scheduledSessionAttribution`), a bound session its binding's.
  // Same precedence as `resolveSessionWorkspace`. Resolved once, like the
  // session itself. Nothing below rewrites the cwd or additional directories
  // `resolveSendOptions` returns, so the confinement roots it derives from
  // them already name the directories the turn works in.
  const activeProject =
    input.workspace === "none"
      ? null
      : await loadOwningWorkspace(session.projectId || session.executionContext?.projectId, {
          goalId,
          sessionId,
        })

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

    // Pacing gate — consulted only between turns (never before the first, when
    // `nextPrompt` is still null) and only when the caller opted in.
    if (input.pacing?.enabled && nextPrompt !== null) {
      const decision = gateContinuation(goal, nowFn(), lastContinuationAt)
      if (decision.kind === "hold") {
        // manualContinue: there is no headless way to advance one turn, so the
        // goal stays active + idle and the driver exits.
        return { status: goal.status, turns, lastResponse, error: "held" }
      }
      if (decision.kind === "defer") {
        const waitMs = Math.min(Math.max(0, decision.untilMs - nowFn()), maxSleepMs)
        if (waitMs > 0) {
          await sleepFn(waitMs)
          continue // re-check status + re-evaluate the gate (bounds long defers)
        }
      }
    }

    const prompt = nextPrompt ?? goal.safeObjective
    const capturedGenerationId = goal.generationId

    let resolved
    try {
      resolved = await resolveSendOptions({
        session,
        appSettings,
        activeGoal: goal,
        activeProject,
      })
    } catch (err) {
      return {
        status: goal.status,
        turns,
        lastResponse,
        error: err instanceof Error ? err.message : String(err),
      }
    }

    const deniedBefore = permissions.denials.length
    let captureText = ""
    let tokensDelta = 0
    let budgetExceeded = false
    let captureUsage: Awaited<ReturnType<typeof runAndCaptureAssistantReply>>["usage"]
    try {
      const capture = await sendTurn(sessionId, prompt, resolved, {
        signal,
        ...(typeof input.perTurnTimeoutMs === "number"
          ? { timeoutMs: input.perTurnTimeoutMs }
          : {}),
        execution: { kind: "goal", label: `Goal ${goalId.slice(0, 8)}`, taskId: goalId },
        onPermissionRequest,
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

    // Per-turn delivery — the connector driver posts each turn to the IM
    // conversation. The scheduler leaves `onTurn` unset (no delivery).
    await input.onTurn?.(captureText, turns, goal)

    const outcome = await handleTurnComplete({
      goalId,
      lastResponse: captureText,
      tokensDelta,
      usage: captureUsage,
      budgetExceeded,
      judgeClient,
      signal,
      capturedGenerationId,
      needsApproval: permissions.denials.slice(deniedBefore).map((denial) => denial.toolName),
    })

    log.debug("Scheduler goal turn complete", {
      goalId,
      turns,
      outcome: outcome.kind,
    })

    switch (outcome.kind) {
      case "continue":
        nextPrompt = outcome.userMessage
        // Baseline for the next pacing gate's interval math.
        lastContinuationAt = nowFn()
        break
      case "exit":
        return {
          status: outcome.resultingStatus,
          turns,
          lastResponse,
          exit: outcome.exit,
          ...(outcome.exit === "needs_approval"
            ? { error: needsApprovalSummary(permissions) }
            : {}),
        }
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
