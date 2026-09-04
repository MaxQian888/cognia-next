/**
 * Workflow-flavoured view of the shared durable step cache.
 *
 * The cache itself lives in `@/lib/durable/idempotency` so a Bot run, whose
 * durable log is `executionRunEvents`, gets the same memoization rules without
 * a second implementation. What stays here is the only workflow-specific part:
 * how to read `workflowRunEvents` and project it onto step completions.
 */

import type { WorkflowRunEventRow } from "@/types/workflow/visual"

import {
  StepMemoCache,
  iterationCacheKey,
  type DurableStepCompletion,
} from "@/lib/durable/idempotency"

import { listRunEvents } from "./event-log"

export { iterationCacheKey }
export type { DurableStepCompletion }

/**
 * Project a workflow run's event log onto step completions. Only successful
 * completions carry an output worth replaying, so everything else is dropped.
 */
export function stepCompletionsFromRunEvents(
  events: readonly WorkflowRunEventRow[]
): DurableStepCompletion[] {
  const completions: DurableStepCompletion[] = []
  for (const event of events) {
    if (event.type !== "step_completed" || !event.stepId) continue
    const payload = event.payload as
      { output?: unknown; loopId?: string; iterationIndex?: number } | undefined
    completions.push({
      stepId: event.stepId,
      output: payload?.output,
      loopId: payload?.loopId,
      iterationIndex: payload?.iterationIndex,
    })
  }
  return completions
}

/**
 * Inngest-style step memoization cache. Each `(runId, stepId)` pair maps to
 * its successful output, so a crashed-and-resumed run replays nothing. The
 * cache is built per-run from the durable Dexie event log on the orchestrator's
 * boot path, and subsequent step completions feed it incrementally.
 */
export class IdempotencyCache extends StepMemoCache {
  /**
   * Hydrate from an existing run's event log. Used by the orchestrator on
   * boot to find where a crashed run should resume.
   */
  static async hydrate(runId: string): Promise<IdempotencyCache> {
    const events = await listRunEvents(runId)
    return new IdempotencyCache().hydrateFrom(stepCompletionsFromRunEvents(events))
  }
}
