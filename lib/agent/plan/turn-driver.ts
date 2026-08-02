/**
 * In-session turn driver for the Unified Plan Execution Hub (ADR-0045 §2, P3).
 *
 * The orchestrated path compiles a plan into a workflow and runs it headlessly.
 * This is the other half the ADR specified and the codebase never grew: for a
 * linear `agent_turn` plan, each step is one VISIBLE turn in the chat session,
 * so the user watches the agent work the plan conversationally.
 *
 * Shaped after `lib/goal/turn-driver.ts`:
 *   - it decides, it does not dispatch. The chat hook owns `sendPrompt`, so
 *     this returns the continuation text and lets the hook send it. Every path
 *     here is therefore unit-testable without IPC.
 *   - **generationId guard**: every mutation re-reads the row and confirms the
 *     generation has not rotated. A pause / cancel / refine mid-turn rotates it,
 *     and this returns `{ kind: "stale" }` instead of trampling that decision.
 *
 * Deliberately NOT here: a judge. A goal loops until a model says it is done;
 * a plan has a finite, ordered step list, so "advance one step per completed
 * turn" is the whole state machine. Quality control is the approval gate before
 * execution and the refinement loop after a failure — not a per-turn verdict.
 */

import type { PlanStatus, PlanStep } from "@/types/agent/plan"
import { appendPlanEvent, getPlan, updatePlan } from "@/lib/db/plans"
import { applyStepStatus, nextRunnableStep } from "./steps"
import { renderPlanStepMessage } from "./prompts"
import { emitPlanStatus } from "./notify"

/** Max characters of the assistant's turn stored as a step's `result` summary. */
const MAX_RESULT_LEN = 500

export type PlanTurnOutcome =
  | { kind: "no_plan" }
  | { kind: "stale"; reason: string }
  | { kind: "aborted" }
  /** Dispatch `userMessage` as the next turn; `stepId` is now `in_progress`. */
  | { kind: "continue"; stepId: string; stepTitle: string; userMessage: string }
  | { kind: "exit"; status: PlanStatus; reason: string }

export interface PlanTurnCompleteInput {
  planId: string
  /** Latest assistant message text — stored as the finished step's result. */
  lastResponse: string
  /**
   * Generation captured at turn start. The driver refuses to mutate the plan
   * when the row's `generationId` no longer matches (the user paused / cancelled
   * / refined mid-turn, and that newer generation owns the next step).
   */
  capturedGenerationId: string
  /** Abort signal — set by the runtime when the status mutates externally. */
  signal?: AbortSignal
}

/**
 * Advance a plan to its next runnable step, or finish it when there is none.
 *
 * Shared by `PlanRuntime.startPlan` (to kick off the first step) and
 * {@link handlePlanTurnComplete} (to move on after a turn), so "what runs next"
 * has exactly one implementation.
 */
export async function advancePlanToNextStep(
  planId: string,
  capturedGenerationId: string
): Promise<PlanTurnOutcome> {
  const plan = await getPlan(planId)
  if (!plan) return { kind: "no_plan" }
  if (plan.generationId !== capturedGenerationId) {
    return { kind: "stale", reason: "generationId rotated before advancing" }
  }

  const next = nextRunnableStep(plan.steps)
  if (!next) {
    // No runnable step left. Everything terminal ⇒ completed; anything still
    // pending means a dependency failed or was skipped, so the plan cannot
    // reach its objective and lands `failed` rather than falsely "completed".
    const stalled = plan.steps.filter(
      (s) => s.status !== "completed" && s.status !== "skipped" && s.status !== "failed"
    )
    const status: PlanStatus =
      plan.steps.some((s) => s.status === "failed") || stalled.length > 0 ? "failed" : "completed"
    const reason =
      status === "completed"
        ? "every plan step completed"
        : "a step failed and the remaining steps depend on it"
    const { getPlanRuntime } = await import("./runtime")
    await getPlanRuntime().finishPlanRun(planId, status, reason)
    return { kind: "exit", status, reason }
  }

  const applied = applyStepStatus(plan.steps, next.id, "in_progress", {
    startedAt: plan.updatedAt,
  })
  await updatePlan(planId, {
    steps: applied.steps,
    totalSteps: applied.totalSteps,
    completedSteps: applied.completedSteps,
    currentStepId: next.id,
  })
  await appendPlanEvent({
    planId,
    kind: "step_started",
    payload: { kind: "step_started", stepId: next.id, title: next.title, stepKind: next.kind },
  })
  const fresh = await getPlan(planId)
  void emitPlanStatus(fresh)
  return {
    kind: "continue",
    stepId: next.id,
    stepTitle: next.title,
    userMessage: renderPlanStepMessage(fresh ?? plan, next),
  }
}

/**
 * Drive one completed turn forward: mark the in-progress step done, then
 * advance. See the module docstring for the state machine.
 */
export async function handlePlanTurnComplete(
  input: PlanTurnCompleteInput
): Promise<PlanTurnOutcome> {
  const { planId, capturedGenerationId, signal } = input

  const plan = await getPlan(planId)
  if (!plan) return { kind: "no_plan" }
  if (plan.generationId !== capturedGenerationId) {
    return { kind: "stale", reason: "generationId rotated since turn start" }
  }
  if (plan.status !== "executing") {
    return { kind: "stale", reason: `plan status is ${plan.status}` }
  }
  if (signal?.aborted) return { kind: "aborted" }

  const current = currentInProgressStep(plan.steps, plan.currentStepId)
  if (current) {
    const result = input.lastResponse.trim().slice(0, MAX_RESULT_LEN)
    const applied = applyStepStatus(plan.steps, current.id, "completed", {
      ...(result ? { result } : {}),
      completedAt: plan.updatedAt,
    })
    await updatePlan(planId, {
      steps: applied.steps,
      totalSteps: applied.totalSteps,
      completedSteps: applied.completedSteps,
      currentStepId: applied.currentStepId,
    })
    await appendPlanEvent({
      planId,
      kind: "step_completed",
      payload: { kind: "step_completed", stepId: current.id, title: current.title },
    })
  }

  // Re-check the guard after the writes: a pause / cancel landing in that
  // window rotates the generation and owns what happens next.
  const after = await getPlan(planId)
  if (!after) return { kind: "no_plan" }
  if (after.generationId !== capturedGenerationId) {
    return { kind: "stale", reason: "generationId rotated after step commit" }
  }
  if (signal?.aborted) return { kind: "aborted" }

  return advancePlanToNextStep(planId, capturedGenerationId)
}

/**
 * The step a finished turn was working: the explicit cursor when it still
 * points at an in-progress step, else any in-progress step (the cursor can lag
 * a concurrent orchestrator write).
 */
export function currentInProgressStep(
  steps: PlanStep[],
  currentStepId?: string
): PlanStep | undefined {
  const cursor = currentStepId ? steps.find((s) => s.id === currentStepId) : undefined
  if (cursor?.status === "in_progress") return cursor
  return [...steps].sort((a, b) => a.order - b.order).find((s) => s.status === "in_progress")
}
