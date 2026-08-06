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

import { executeDeployedWorkflow, WorkflowAdmissionError } from "./execution-authority"

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
  const runId =
    input.runId ?? "run_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)

  // Fire-and-forget: the orchestrator persists the run row inline before the
  // first step executes, so the row exists by the time callers correlate.
  // Awaiting the full run would block the inbound 202 for the whole duration.
  let markAdmitted: () => void = () => undefined
  const admitted = new Promise<void>((resolve) => {
    markAdmitted = resolve
  })
  const execution = executeDeployedWorkflow({
    workflowId: input.workflowId,
    entrypoint: "http",
    caller: input.deviceId ? `device:${input.deviceId}` : "remote-control",
    idempotencyKey: input.runId,
    requestedRunId: runId,
    triggerKind: "trigger.manual",
    payload: input.runParams ?? {},
    signal: input.signal,
    triggeredBy: { source: "api", ...(input.deviceId ? { deviceId: input.deviceId } : {}) },
    onAdmitted: markAdmitted,
  })
  try {
    await Promise.race([execution.then(() => undefined), admitted])
  } catch (error) {
    if (error instanceof WorkflowAdmissionError && error.code === "deployment-not-found") {
      return { ok: false, reason: "workflow-not-found", workflowId: input.workflowId }
    }
    throw error
  }

  return { ok: true, runId }
}
