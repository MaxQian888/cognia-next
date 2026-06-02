/**
 * Real desktop wiring for the Visual Workflow eval target. Loads the workflow
 * definition, drives `runWorkflow` with the case's `inputVars` as a manual
 * trigger payload, threading the run-scoped `traceId` so AI nodes emit their
 * LLM spans under it. Spans are read back by trace via `queryByTrace`.
 */

import { queryByTrace } from "@/lib/db/agent-traces"
import type { WorkflowTargetDeps } from "./workflow"

export function defaultWorkflowTargetDeps(): WorkflowTargetDeps {
  return {
    async runWorkflow({ workflowId, payload, traceId, signal }) {
      const [{ getWorkflow }, { runWorkflow }] = await Promise.all([
        import("@/lib/db/workflows"),
        import("@/lib/workflow/runtime/orchestrator"),
      ])
      const workflow = await getWorkflow(workflowId)
      if (!workflow) throw new Error(`eval workflow target: workflow "${workflowId}" not found`)
      const result = await runWorkflow({
        workflow,
        trigger: {
          workflowId,
          kind: "trigger.manual",
          payload,
          originAt: Date.now(),
        },
        traceId,
        ...(signal ? { signal } : {}),
      })
      return {
        runId: result.runId,
        status: result.status,
        output: result.output,
        traceId,
      }
    },
    fetchSpansByTrace: (traceId: string) => queryByTrace(traceId),
  }
}
