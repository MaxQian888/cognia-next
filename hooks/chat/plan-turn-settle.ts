/**
 * How a settled chat turn moves an in-session plan (ADR-0045), shared by every
 * runtime that can run a plan step.
 *
 * The in-session driver advances a plan ONLY through `handlePlanTurnComplete`,
 * and that was called from the built-in sidecar's success path alone
 * (`claude-chat-events.ts`). A step run on an external agent (Pi, commandcode)
 * therefore never completed and never failed: it sat `in_progress` until the
 * step watchdog gave up on it. Both runtimes now call these two functions, so a
 * plan step behaves the same whichever lane its turn ran on:
 *
 *  - {@link driveInSessionPlanAfterTurn} — a turn that finished: mark the step
 *    done and dispatch the next one (or post the plan's exit card).
 *  - {@link haltInSessionPlanOnTurnFailure} — a turn that failed: halt the plan
 *    on the step with the classified cause, so the tracker offers retry / skip /
 *    mark done instead of waiting for a watchdog.
 *
 * Both re-read the executing plan and guard on its strategy and generation, the
 * way the built-in path always has: an ORCHESTRATED plan also sits at
 * `executing` while the workflow runtime owns its steps, and a paused / retried
 * / cancelled plan has rotated its generation.
 */

import type { UIMessage } from "ai"
import type { PlanStepHaltCause } from "@/types/agent/plan"
import { useChatStore } from "@/stores/chat"
import { commitMessageDelta } from "@/lib/db/messages"
import { renderPlanExitCard } from "./claude-chat-turn-tasks"

export interface DriveInSessionPlanInput {
  sessionId: string
  /** The finished turn's assistant text — becomes the step's `result`. */
  lastResponse: string
  /** Whether `sessionId` is the focused session (the next step is only sent there). */
  isActiveSession: () => boolean
  /** Send the next step's turn (`skipUserAppend`: the runtime already wrote it). */
  dispatchNextStep: (userMessage: string) => void
}

/**
 * Advance the session's executing in-session plan after a turn completed.
 * Resolves `true` when it dispatched the next step's turn. Errors are logged,
 * never thrown: a plan bookkeeping failure must not turn a successful chat turn
 * into a failed one.
 */
export async function driveInSessionPlanAfterTurn(
  input: DriveInSessionPlanInput
): Promise<boolean> {
  const { sessionId } = input
  try {
    const { getPlanRuntime } = await import("@/lib/agent/plan/runtime")
    const activePlan = await getPlanRuntime().getExecutingPlanForSession(sessionId)
    if (!activePlan) return false
    const { resolvePlanStrategy } = await import("@/lib/agent/plan/strategy")
    if (resolvePlanStrategy(activePlan) !== "in_session") return false
    const { handlePlanTurnComplete } = await import("@/lib/agent/plan/turn-driver")
    const ac = new AbortController()
    const unregister = getPlanRuntime().registerAbortController(activePlan.id, ac)
    let outcome: Awaited<ReturnType<typeof handlePlanTurnComplete>>
    try {
      const { defaultLifecycleFirer } = await import("@/lib/claude/hooks/lifecycle-firer")
      outcome = await handlePlanTurnComplete({
        planId: activePlan.id,
        lastResponse: input.lastResponse,
        capturedGenerationId: activePlan.generationId,
        signal: ac.signal,
        // Bracket each plan step with settings.json lifecycle hooks, the same
        // way the goal driver does.
        firer: defaultLifecycleFirer,
        hookContext: {
          agentId: "plan-step",
          agentKind: "plan-step",
          agentRef: activePlan.id,
          sessionId,
        },
      })
    } finally {
      unregister()
    }
    if (outcome.kind === "exit") {
      const card: UIMessage = {
        id: `sys-plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        role: "system",
        parts: [
          {
            type: "text",
            text: renderPlanExitCard(activePlan.title, outcome.status, outcome.reason),
          },
        ],
      }
      // The plan's own conversation, never whichever one has focus: this runs
      // for background sessions too. In memory only when that slice is loaded,
      // and on disk as one row — a whole-array replace from a partial (or
      // another session's) array would delete every row it does not hold.
      const store = useChatStore.getState()
      if (store.sessions[sessionId] || store.activeSessionId === sessionId) {
        store.appendSessionMessage(sessionId, card)
      }
      await commitMessageDelta(sessionId, { upserts: [card] }).catch(() => {})
    } else if (outcome.kind === "continue" && input.isActiveSession()) {
      // No pacing gate: a plan has a finite step list, so the next step follows
      // immediately (the user pauses via the tracker dock, which rotates the
      // generation and makes this `stale`).
      input.dispatchNextStep(outcome.userMessage)
      return true
    }
    // aborted | stale | no_plan → no-op: a pause/cancel/refine owns the next
    // step and the tracker dock reflects the status.
    return false
  } catch (err) {
    console.warn("plan turn-driver failed", err)
    return false
  }
}

export interface HaltInSessionPlanInput {
  sessionId: string
  /**
   * `not_started` for a turn refused before the agent ran (it never started,
   * a working copy or agent process was held elsewhere); `turn_failed` for one
   * that started and failed.
   */
  cause: Extract<PlanStepHaltCause, "turn_failed" | "not_started">
  /** Technical detail: the diagnostic code and the runtime's own words. */
  detail: string
}

/**
 * Halt the session's executing in-session plan on its current step after the
 * step's turn failed. A no-op when no in-session plan is executing, and — via
 * the runtime's own guards — when the plan was paused, retried or cancelled
 * since (its generation rotated) or the step already moved on.
 */
export async function haltInSessionPlanOnTurnFailure(input: HaltInSessionPlanInput): Promise<void> {
  try {
    const { getPlanRuntime } = await import("@/lib/agent/plan/runtime")
    const runtime = getPlanRuntime()
    const activePlan = await runtime.getExecutingPlanForSession(input.sessionId)
    if (!activePlan) return
    const { resolvePlanStrategy } = await import("@/lib/agent/plan/strategy")
    if (resolvePlanStrategy(activePlan) !== "in_session") return
    const { currentInProgressStep } = await import("@/lib/agent/plan/steps")
    const step = currentInProgressStep(activePlan.steps, activePlan.currentStepId)
    await runtime.failInSessionStep(activePlan.id, {
      ...(step ? { stepId: step.id } : {}),
      cause: input.cause,
      detail: input.detail,
      capturedGenerationId: activePlan.generationId,
    })
  } catch (err) {
    console.warn("plan step halt failed", err)
  }
}
