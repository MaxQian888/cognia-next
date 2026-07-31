/**
 * Thin wrapper around `runWorkflow` for IM-originated runs.
 *
 * Why a wrapper instead of calling `runWorkflow` directly: every IM-side
 * caller needs the same three things:
 *
 *   1. Look up the frozen `VisualWorkflow` from Dexie by id (the by-name
 *      tool already resolved the id; here we hydrate the row).
 *   2. Build the `TriggerEvent` envelope with `kind: "trigger.manual"` —
 *      the same kind the editor's "Run now" button uses.
 *   3. Pass `triggeredBy` so the IM progress-runner can subscribe.
 *
 * Returning a thin `{runId}` instead of the full `RunWorkflowResult`
 * because the caller (bus dispatcher for `wf_approve`) waits only for the
 * durable run row, not completion. Completion shows up as a final-summary
 * card pushed by the runner, not as a tool response.
 */

import { getWorkflow } from "@/lib/db/workflows"
import { runWorkflow } from "./orchestrator"
import type { TriggerEvent, WorkflowTriggeredFrom } from "@/types/workflow/visual"

export interface StartWorkflowFromIMInput {
  workflowId: string
  /** Free-form payload — surfaced to trigger-aware nodes as `$trigger.payload`. */
  runParams?: Record<string, unknown>
  /** IM origin metadata. Required so progress fans back to the right chat. */
  triggeredFrom: WorkflowTriggeredFrom
  /** Optional external AbortSignal — propagates to the orchestrator. */
  signal?: AbortSignal
}

export type StartWorkflowFromIMResult =
  { ok: true; runId: string } | { ok: false; reason: "workflow-not-found"; workflowId: string }

/**
 * Start a workflow on behalf of an IM user. Returns as soon as the run row
 * is persisted while the orchestrator continues in the background. Run-status fan-out is handled by
 * `lib/connectors/a2ui-bridge/workflow-progress-runner.ts`, which Dexie-
 * live-queries `workflowRunEvents` for any run whose `triggeredBy.source`
 * is `"im"`.
 */
export async function startWorkflowFromIM(
  input: StartWorkflowFromIMInput
): Promise<StartWorkflowFromIMResult> {
  const workflow = await getWorkflow(input.workflowId)
  if (!workflow) return { ok: false, reason: "workflow-not-found", workflowId: input.workflowId }

  const trigger: TriggerEvent = {
    workflowId: workflow.id,
    kind: "trigger.manual",
    payload: input.runParams ?? {},
    originAt: Date.now(),
    binding: {
      adapterId: input.triggeredFrom.adapterId,
      conversationKey: input.triggeredFrom.conversationKey,
      sessionId: input.triggeredFrom.sessionId,
    },
  }

  // Generate the runId up front so callers can correlate logs / outbound
  // metadata before the orchestrator promise resolves. We pass it back
  // synchronously and let the orchestrator promise progress in the
  // background — the runner subscribes via Dexie liveQuery, no shared
  // promise needed.
  const runId = "run_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)

  // Detach after the orchestrator persists its run row. Awaiting the FULL run
  // would block the caller for the entire workflow duration.
  let markPersisted: () => void = () => undefined
  const persisted = new Promise<void>((resolve) => {
    markPersisted = resolve
  })
  const execution = runWorkflow({
    workflow,
    trigger,
    runId,
    signal: input.signal,
    triggeredBy: input.triggeredFrom,
    onPersisted: markPersisted,
  })
  // A valid run resolves `persisted` immediately after its durable row lands.
  // A validation/preflight failure can finish before creating that row, so the
  // execution promise is the second race arm and prevents this handoff from
  // hanging. The race also owns the rejection handler for the detached run.
  await Promise.race([persisted, execution.then(() => undefined)])

  return { ok: true, runId }
}
