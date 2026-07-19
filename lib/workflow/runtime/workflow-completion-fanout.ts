/**
 * Workflow-completed chain trigger (ADR-0081) — the "run B when A finishes"
 * linkage `flow.subworkflow` can't express (that node embeds the child INSIDE
 * the parent run; this fanout decouples the two graphs entirely).
 *
 * The orchestrator calls {@link emitWorkflowCompletedFanout} (fire-and-forget)
 * on every terminal run state. Matching `trigger.workflow.completed` nodes are
 * resolved through the in-memory trigger index and dispatched through the
 * canonical trigger bridge, so a chained run is indistinguishable from any
 * other triggered run (event log, plugin hooks, IM fan-out all behave).
 *
 * Loop / storm protection, mirroring `flow.subworkflow`'s depth guard:
 *  - `chainDepth` rides the trigger payload; a chain longer than
 *    {@link MAX_WORKFLOW_CHAIN_DEPTH} stops fanning out (logged, not thrown).
 *  - A workflow never triggers ITSELF (A completed → A would re-run forever;
 *    rejected per match, even when the node's filter is unscoped).
 *
 * All workflow-runtime imports are lazy — the emitter is called from the
 * orchestrator, and the trigger bridge imports the orchestrator back, so a
 * static import would be a cycle.
 */

import type { RunStatus, TriggerEvent, WorkflowRunError } from "@/types/workflow/visual"
import { loggers } from "@cognia/logging"

const log = loggers.scheduler

/** Hard ceiling on chained-trigger depth (A → B → C → …). */
export const MAX_WORKFLOW_CHAIN_DEPTH = 10

/**
 * Chain depth already consumed by the run that just finished: 0 for organic
 * runs, N for a run that was itself started by a workflow-completed trigger
 * (the emitter stamped `chainDepth: N` onto that trigger's payload).
 */
export function chainDepthOf(trigger: TriggerEvent): number {
  if (trigger.kind !== "trigger.workflow.completed") return 0
  const payload = trigger.payload as { chainDepth?: unknown } | null | undefined
  const depth = typeof payload?.chainDepth === "number" ? payload.chainDepth : 0
  return Number.isFinite(depth) && depth > 0 ? Math.floor(depth) : 0
}

/** Payload delivered to the chained workflow as `$trigger.payload`. */
export interface WorkflowCompletedPayload {
  /** Source workflow that finished. */
  workflowId: string
  workflowName: string
  runId: string
  status: Extract<RunStatus, "succeeded" | "failed">
  /** Terminal output (succeeded runs). */
  output?: unknown
  /** Terminal error envelope (failed runs). */
  error?: WorkflowRunError
  /** Depth of THIS link in the trigger chain (1 = first chained hop). */
  chainDepth: number
}

export interface EmitWorkflowCompletedInput {
  workflow: { id: string; name: string }
  runId: string
  status: Extract<RunStatus, "succeeded" | "failed">
  output?: unknown
  error?: WorkflowRunError
  /** The finished run's own trigger — source of the inherited chain depth. */
  trigger: TriggerEvent
}

/**
 * Fan a terminal run state out to every matching `trigger.workflow.completed`
 * subscription. Best-effort by contract: the caller fires-and-forgets, and a
 * bad target workflow must never affect the finished run (per-match isolation)
 * or its siblings.
 */
export async function emitWorkflowCompletedFanout(
  input: EmitWorkflowCompletedInput
): Promise<void> {
  try {
    const depth = chainDepthOf(input.trigger) + 1
    if (depth > MAX_WORKFLOW_CHAIN_DEPTH) {
      log.warn?.("workflow-completion-fanout: chain depth cap reached; not fanning out", {
        workflowId: input.workflow.id,
        runId: input.runId,
        depth,
        cap: MAX_WORKFLOW_CHAIN_DEPTH,
      })
      return
    }

    const [{ findMatchingWorkflows }, { dispatchTrigger }] = await Promise.all([
      import("./trigger-subscriptions"),
      import("./trigger-bridge"),
    ])

    const matches = findMatchingWorkflows("trigger.workflow.completed", {
      sourceWorkflowId: input.workflow.id,
      status: input.status,
    })
    if (matches.length === 0) return

    const payload: WorkflowCompletedPayload = {
      workflowId: input.workflow.id,
      workflowName: input.workflow.name,
      runId: input.runId,
      status: input.status,
      ...(input.output !== undefined ? { output: input.output } : {}),
      ...(input.error ? { error: input.error } : {}),
      chainDepth: depth,
    }

    const originAt = Date.now()
    await Promise.all(
      matches.map((match) => {
        // Self-trigger protection: a workflow listening for its own completion
        // is an unconditional infinite loop — reject the match outright.
        if (match.workflowId === input.workflow.id) {
          log.warn?.("workflow-completion-fanout: self-trigger rejected", {
            workflowId: input.workflow.id,
            nodeId: match.nodeId,
          })
          return Promise.resolve()
        }
        return dispatchTrigger({
          workflowId: match.workflowId,
          kind: "trigger.workflow.completed",
          triggerId: match.nodeId,
          payload,
          originAt,
        }).catch((err) => {
          // Per-match isolation — one bad chained workflow can't block others.
          log.warn?.("workflow-completion-fanout: chained dispatch failed", {
            sourceWorkflowId: input.workflow.id,
            targetWorkflowId: match.workflowId,
            error: err instanceof Error ? err.message : String(err),
          })
        })
      })
    )
  } catch (err) {
    // Workflow runtime unavailable (e.g. stripped web build) — best-effort.
    log.warn?.("workflow-completion-fanout: fanout skipped", {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
