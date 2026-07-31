/**
 * "Re-run from this step" — re-execute a step and its entire descendant
 * subgraph, reusing the upstream outputs already computed in a prior run so the
 * ancestor cone is NOT re-executed. Backs the run-history detail view's
 * per-step re-run action.
 *
 * Mechanism: seed every `step_completed` output from `seedFromRunId` into the
 * idempotency cache and hand the orchestrator `startStepId`. The orchestrator
 * skips everything outside the start step's descendant subgraph; its
 * seed-survives-skip rule (`scheduleOne`) then feeds the seeded ancestor
 * outputs into the re-run, so the start step sees the same inputs it saw in the
 * original run instead of `undefined`.
 *
 * Contrast:
 *   • `runSingleNode` — target + ANCESTORS (no descendants); the n8n
 *     "execute step" experience.
 *   • the editor's plain `startStepId` — target + descendants with NO seed
 *     (the start step's upstream collapses to `undefined`).
 *   • `runFromStep` — target + descendants WITH the prior run's upstream seeded.
 */

import { getDb } from "@/lib/db/schema"
import { runWorkflow, type RunWorkflowResult } from "./orchestrator"
import type { SecretResolver } from "./secret-resolver"
import type { TriggerEvent, VisualWorkflow } from "@/types/workflow/visual"

/** Per-step outputs from a specific run's `step_completed` events, keyed by step id. */
export async function getRunStepOutputs(runId: string): Promise<Record<string, unknown>> {
  const events = await getDb()
    .workflowRunEvents.where("[runId+ts]")
    .between([runId, 0], [runId, Number.MAX_SAFE_INTEGER])
    .toArray()
  const out: Record<string, unknown> = {}
  for (const ev of events) {
    if (ev.type === "step_completed" && ev.stepId) {
      const payload = ev.payload as { output?: unknown } | undefined
      if (payload && "output" in payload) out[ev.stepId] = payload.output
    }
  }
  return out
}

export interface RunFromStepInput {
  workflow: VisualWorkflow
  /** The step to re-run from — it and every descendant re-execute. */
  startStepId: string
  /** Run whose completed-step outputs seed the skipped ancestor cone. */
  seedFromRunId?: string
  /** Test injection — bypasses the event-log read when provided. */
  seedOutputs?: Record<string, unknown>
  /** Trigger to attach; defaults to a manual trigger. */
  trigger?: TriggerEvent
  secretResolver?: SecretResolver
  signal?: AbortSignal
  /** Suppress the terminal-failure catch phase in the spawned run. */
  suppressCatch?: boolean
}

export async function runFromStep(input: RunFromStepInput): Promise<RunWorkflowResult> {
  const { workflow, startStepId } = input
  const seedOutputs =
    input.seedOutputs ?? (input.seedFromRunId ? await getRunStepOutputs(input.seedFromRunId) : {})
  const trigger: TriggerEvent = input.trigger ?? {
    workflowId: workflow.id,
    kind: "trigger.manual",
    payload: {},
    originAt: Date.now(),
  }
  return runWorkflow({
    workflow,
    trigger,
    startStepId,
    seedOutputs,
    secretResolver: input.secretResolver,
    signal: input.signal,
    ...(input.suppressCatch ? { suppressCatch: true } : {}),
  })
}
