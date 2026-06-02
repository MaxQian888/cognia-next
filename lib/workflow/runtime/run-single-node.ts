/**
 * "Run this step" — execute a single node (plus any ancestors that lack data),
 * reusing pinned / last-run upstream outputs instead of re-running the whole
 * upstream. This is the n8n "execute step" experience.
 *
 * Contrast with the orchestrator's `startStepId` ("Run from here"), which runs
 * the target node AND everything downstream. Here we bound the run to the
 * ancestor cone, seed ancestors that already have data, and only execute the
 * target + ancestors without data.
 */

import { runWorkflow, type RunWorkflowResult } from "./orchestrator"
import { getLatestRunOutputs } from "@/hooks/workflow/use-latest-run-outputs"
import type { SecretResolver } from "./secret-resolver"
import type { TriggerEvent, VisualWorkflow } from "@/types/workflow/visual"

export interface RunSingleNodeInput {
  workflow: VisualWorkflow
  nodeId: string
  secretResolver?: SecretResolver
  signal?: AbortSignal
  /**
   * Override the latest-run output lookup (tests inject; production reads the
   * event log via `getLatestRunOutputs`).
   */
  latestOutputs?: Record<string, unknown>
}

/** All transitive ancestors of `nodeId` (excludes the node itself). */
export function ancestorsOf(workflow: VisualWorkflow, nodeId: string): Set<string> {
  const incoming = new Map<string, string[]>()
  for (const e of workflow.edges) {
    const arr = incoming.get(e.target)
    if (arr) arr.push(e.source)
    else incoming.set(e.target, [e.source])
  }
  const result = new Set<string>()
  const queue: string[] = [nodeId]
  while (queue.length > 0) {
    const cur = queue.shift() as string
    for (const src of incoming.get(cur) ?? []) {
      if (!result.has(src)) {
        result.add(src)
        queue.push(src)
      }
    }
  }
  // Guard against a cycle through the target re-adding itself.
  result.delete(nodeId)
  return result
}

export async function runSingleNode(input: RunSingleNodeInput): Promise<RunWorkflowResult> {
  const { workflow, nodeId } = input
  const ancestors = ancestorsOf(workflow, nodeId)
  const latestOutputs =
    input.latestOutputs ?? (await getLatestRunOutputs(workflow.id, { anyStatus: true }))
  const pin = workflow.pinData ?? {}

  // Seed ancestors that already have pinned / last-run data so they cache-hit
  // (no re-execution); ancestors without data fall through and execute.
  const seedOutputs: Record<string, unknown> = {}
  for (const a of ancestors) {
    if (Object.prototype.hasOwnProperty.call(pin, a)) seedOutputs[a] = pin[a]
    else if (Object.prototype.hasOwnProperty.call(latestOutputs, a))
      seedOutputs[a] = latestOutputs[a]
  }

  const restrictToStepIds = [nodeId, ...ancestors]
  const trigger: TriggerEvent = {
    workflowId: workflow.id,
    kind: "trigger.manual",
    payload: {},
    originAt: Date.now(),
  }

  return runWorkflow({
    workflow,
    trigger,
    seedOutputs,
    restrictToStepIds,
    honorPinData: true,
    secretResolver: input.secretResolver,
    signal: input.signal,
  })
}
