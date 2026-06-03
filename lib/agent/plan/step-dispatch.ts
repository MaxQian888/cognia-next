/**
 * Per-kind execution for one `PlanStep` in the orchestrated path (ADR-0045 P2).
 *
 * `dispatchPlanStepNode` is the body of the `action.plan.step.dispatch` node
 * executor, isolated here so it's unit-testable without the workflow
 * orchestrator. It marks the step in_progress, runs the kind-specific work via
 * `runStepWork`, then writes completed / failed back through the run context's
 * writer.
 *
 * Implemented kinds: `agent_turn` (headless `executeAgent`), `approval_gate`
 * (`lib/runtime/approval-bus`), `sub_workflow` (nested `runWorkflow`).
 * `tool_call` and `teammate_dispatch` land in P3 — they throw a non-retryable
 * error naming the phase so an unimplemented kind fails loudly rather than
 * silently succeeding.
 */

import type { StepExecutionResult, TriggerEvent } from "@/types/workflow/visual"
import type { PlanStep } from "@/types/agent/plan"
import type { PlanRunContext } from "./plan-run-context"

/** The approval-bus scope plan `approval_gate` steps wait on. */
export const PLAN_APPROVAL_SCOPE = "agent-plan"

/** Build the approval-bus key for a plan step's approval gate. */
export function planApprovalKey(planId: string, stepId: string): { scope: string; id: string } {
  return { scope: PLAN_APPROVAL_SCOPE, id: `${planId}:${stepId}` }
}

function nonRetryable(message: string): Error {
  const err = new Error(message) as Error & { retryable?: boolean }
  err.retryable = false
  return err
}

interface StepWorkResult {
  value: unknown
  summary: string
}

/** Derive the turn/approval prompt text for a step. */
function stepPrompt(step: PlanStep): string {
  if (step.params?.kind === "agent_turn" && step.params.prompt) return step.params.prompt
  if (step.params?.kind === "approval_gate" && step.params.prompt) return step.params.prompt
  return step.description ? `${step.title}\n\n${step.description}` : step.title
}

async function runStepWork(
  runCtx: PlanRunContext,
  step: PlanStep,
  signal: AbortSignal
): Promise<StepWorkResult> {
  switch (step.kind) {
    case "agent_turn": {
      const { executeAgent } = await import("@/lib/ai/agent/agent-executor")
      const result = await executeAgent(stepPrompt(step), {
        toolsEnabled: true,
        ...(runCtx.characterId ? { characterId: runCtx.characterId } : {}),
        abortSignal: signal,
      })
      return { value: { text: result.text, channel: result.channel }, summary: result.text }
    }

    case "approval_gate": {
      const { waitForDecision } = await import("@/lib/runtime/approval-bus")
      const decision = await waitForDecision(planApprovalKey(runCtx.planId, step.id), signal)
      if (decision.outcome === "reject") {
        throw nonRetryable(
          `plan approval gate rejected${decision.feedback ? `: ${decision.feedback}` : ""}`
        )
      }
      return { value: { outcome: decision.outcome }, summary: "approved" }
    }

    case "sub_workflow": {
      if (step.params?.kind !== "sub_workflow" || !step.params.workflowId) {
        throw nonRetryable("sub_workflow step requires params.workflowId")
      }
      const [{ getWorkflow }, { runWorkflow }] = await Promise.all([
        import("@/lib/db/workflows"),
        import("@/lib/workflow/runtime/orchestrator"),
      ])
      const sub = await getWorkflow(step.params.workflowId)
      if (!sub) throw nonRetryable(`sub_workflow: workflow "${step.params.workflowId}" not found`)
      const trigger: TriggerEvent = {
        workflowId: sub.id,
        kind: "trigger.manual",
        payload: step.params.triggerPayload ?? {},
        originAt: Date.now(),
      }
      const result = await runWorkflow({ workflow: sub, trigger, signal })
      if (result.status !== "succeeded") {
        throw new Error(`sub_workflow ended with status "${result.status}"`)
      }
      return { value: result.output, summary: `sub-workflow ${sub.name} completed` }
    }

    case "tool_call":
      throw nonRetryable("tool_call steps are wired in ADR-0045 P3")

    case "teammate_dispatch":
      throw nonRetryable("teammate_dispatch steps are wired in ADR-0045 P3")

    default: {
      const exhaustive: never = step.kind
      throw nonRetryable(`unknown plan step kind: ${String(exhaustive)}`)
    }
  }
}

/**
 * Execute one plan step, writing its status transitions through the run
 * context. Returns the workflow node result. On failure the step is marked
 * `failed` and the error is re-thrown so the orchestrator's retry / error
 * policy applies.
 */
export async function dispatchPlanStepNode(
  runCtx: PlanRunContext,
  stepId: string,
  signal: AbortSignal
): Promise<StepExecutionResult> {
  const step = runCtx.plan.steps.find((s) => s.id === stepId)
  if (!step) {
    throw nonRetryable(`action.plan.step.dispatch: step "${stepId}" not in plan "${runCtx.planId}"`)
  }

  const startedAt = Date.now()
  await runCtx.writer.setStepStatus(step.id, "in_progress", { startedAt })

  try {
    const work = await runStepWork(runCtx, step, signal)
    const completedAt = Date.now()
    await runCtx.writer.setStepStatus(step.id, "completed", {
      result: work.summary.slice(0, 2000),
      output: work.value,
      completedAt,
      actualDurationMs: completedAt - startedAt,
    })
    return { output: work.value }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await runCtx.writer.setStepStatus(step.id, "failed", {
      error: message,
      completedAt: Date.now(),
      attempts: (step.attempts ?? 0) + 1,
    })
    throw err
  }
}
