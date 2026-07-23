/**
 * Thin wrapper around `runWorkflow` for remote-control-originated runs.
 *
 * Mirrors `start-from-im.ts` but stamps `triggeredBy.source: "api"` — the
 * remote-control inbound server is, semantically, an HTTP API trigger (the
 * existing `WorkflowTriggeredFrom.source` union already carries `"api"`, so no
 * type change is needed). Fire-and-forget: returns a `runId` synchronously and
 * lets the orchestrator promise progress in the background, so the inbound
 * HTTP caller's 202 stays fast.
 */

import { getWorkflow } from "@/lib/db/workflows"
import { runWorkflow } from "./orchestrator"
import type { TriggerEvent } from "@/types/workflow/visual"

export interface StartWorkflowFromRemoteInput {
  workflowId: string
  /** Free-form payload — surfaced to trigger-aware nodes as `$trigger.payload`. */
  runParams?: Record<string, unknown>
  signal?: AbortSignal
  /** Caller-provided runId so the dispatch layer can correlate the audit row. */
  runId?: string
  /**
   * Paired-device id of the remote caller (ADR-0060), when the dispatch
   * layer knows it. Stamped into `triggeredBy.deviceId` on the run row.
   */
  deviceId?: string
}

export type StartWorkflowFromRemoteResult =
  { ok: true; runId: string } | { ok: false; reason: "workflow-not-found"; workflowId: string }

export async function startWorkflowFromRemote(
  input: StartWorkflowFromRemoteInput
): Promise<StartWorkflowFromRemoteResult> {
  const workflow = await getWorkflow(input.workflowId)
  if (!workflow) return { ok: false, reason: "workflow-not-found", workflowId: input.workflowId }

  const trigger: TriggerEvent = {
    workflowId: workflow.id,
    kind: "trigger.manual",
    payload: input.runParams ?? {},
    originAt: Date.now(),
  }

  const runId =
    input.runId ?? "run_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)

  // Fire-and-forget: the orchestrator persists the run row inline before the
  // first step executes, so the row exists by the time callers correlate.
  // Awaiting the full run would block the inbound 202 for the whole duration.
  void runWorkflow({
    workflow,
    trigger,
    runId,
    signal: input.signal,
    triggeredBy: { source: "api", ...(input.deviceId ? { deviceId: input.deviceId } : {}) },
  })

  return { ok: true, runId }
}
