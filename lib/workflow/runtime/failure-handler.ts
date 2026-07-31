/**
 * Terminal-failure safety net (run-fallback, A1/A2).
 *
 * When a run fails terminally (retries exhausted / errorPolicy resolves to
 * stop with no handled branch), the orchestrator calls {@link runCatchHandlers}
 * to execute every top-level `flow.catch` node + its downstream as a recovery
 * phase. Each catch node runs as its OWN sub-run (via `runFromStep`), so the
 * recovery path reuses the full step machinery (retry, events, secrets) without
 * re-implementing orchestration. The error envelope is injected through the
 * synthetic trigger's `$catch` payload; the `flow.catch` executor surfaces it
 * as its output so downstream nodes can branch / notify on it.
 *
 * The spawned sub-runs carry `suppressCatch` so a failing recovery path never
 * recurses into its own catch handlers.
 */

import type { VisualWorkflow, WorkflowNode } from "@/types/workflow/visual"
import type { SecretResolver } from "./secret-resolver"
import { runFromStep } from "./run-from-step"

export interface RunFailureError {
  /** Node id that originated the terminal failure. */
  stepId: string
  message: string
  /** Optional discriminator (e.g. "timeout", "circuit_open"). */
  code?: string
}

export interface CatchPhaseResult {
  /** Number of catch nodes that were run. */
  handlersRun: number
  /** The sub-run ids spawned (one per catch node). */
  runIds: string[]
}

/**
 * Top-level `flow.catch` nodes. Loop-body catch nodes (`parentId` set) are
 * excluded — they belong to a container subgraph, not the run-level safety net.
 */
export function findCatchNodes(workflow: VisualWorkflow): WorkflowNode[] {
  return workflow.nodes.filter((n) => n.type === "flow.catch" && !n.parentId)
}

export async function runCatchHandlers(input: {
  workflow: VisualWorkflow
  error: RunFailureError
  secretResolver?: SecretResolver
  signal?: AbortSignal
}): Promise<CatchPhaseResult> {
  const catches = findCatchNodes(input.workflow)
  const runIds: string[] = []
  for (const node of catches) {
    const result = await runFromStep({
      workflow: input.workflow,
      startStepId: node.id,
      seedOutputs: {},
      trigger: {
        workflowId: input.workflow.id,
        kind: "trigger.manual",
        payload: { $catch: input.error },
        originAt: Date.now(),
      },
      secretResolver: input.secretResolver,
      signal: input.signal,
      suppressCatch: true,
    })
    runIds.push(result.runId)
  }
  return { handlersRun: catches.length, runIds }
}
