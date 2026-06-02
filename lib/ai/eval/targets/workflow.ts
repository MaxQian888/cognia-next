/**
 * Visual Workflow eval target — drives a workflow run for a case and assembles
 * the captured trajectory into an {@link EvalSample}.
 *
 * The case's `inputVars` become the workflow trigger payload (falling back to
 * `{ input }`). Like the team target, a workflow run spans node executions, so
 * a run-scoped `traceId` is threaded in and spans are read back by trace. The
 * final workflow output (stringified) is the sample output. DI for testing;
 * real wiring lives in `workflow-default-deps.ts`.
 */

import type { AgentTraceSpan } from "@/types/agent-trace/span"
import type { EvalCase, EvalSample } from "@/types/eval/eval"
import type { EvalTarget } from "../runner"
import { assembleSampleFromSpans } from "./chat"
import { newEvalTraceId } from "./span-scope"

export interface WorkflowTargetConfig {
  label: string
  workflowId: string
  timeoutMs?: number
}

export interface WorkflowTargetDeps {
  runWorkflow(input: {
    workflowId: string
    payload: Record<string, unknown>
    traceId: string
    timeoutMs?: number
    signal?: AbortSignal
  }): Promise<{ runId: string; status: string; output?: unknown; traceId: string }>
  fetchSpansByTrace(traceId: string): Promise<AgentTraceSpan[]>
}

function outputToText(output: unknown): string {
  if (output === undefined || output === null) return ""
  return typeof output === "string" ? output : JSON.stringify(output)
}

export function createWorkflowTarget(
  config: WorkflowTargetConfig,
  deps: WorkflowTargetDeps
): EvalTarget {
  return {
    label: config.label,
    async run(evalCase: EvalCase, signal?: AbortSignal): Promise<EvalSample> {
      const traceId = newEvalTraceId()
      const payload =
        evalCase.inputVars && Object.keys(evalCase.inputVars).length > 0
          ? evalCase.inputVars
          : { input: evalCase.input }
      const { output } = await deps.runWorkflow({
        workflowId: config.workflowId,
        payload,
        traceId,
        ...(config.timeoutMs ? { timeoutMs: config.timeoutMs } : {}),
        ...(signal ? { signal } : {}),
      })
      const spans = await deps.fetchSpansByTrace(traceId)
      // Workflows are always "tool-capable" in the node-execution sense.
      return assembleSampleFromSpans(spans, { output: outputToText(output), degraded: false })
    },
  }
}
