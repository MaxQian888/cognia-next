/**
 * Thin wrapper around Execution Authority for IM-originated formal runs.
 *
 * Why a wrapper instead of calling the authority directly: every IM-side
 * caller needs the same three things:
 *
 *   1. Resolve and pin the active production artifact by workflow id.
 *   2. Build the formal trigger envelope with `kind: "trigger.manual"` —
 *      the same kind the editor's "Run now" button uses.
 *   3. Pass `triggeredBy` so the IM progress-runner can subscribe.
 *
 * Returning a thin `{runId}` instead of the full authority result
 * because the caller (bus dispatcher for `wf_approve`) waits only for the
 * durable run row, not completion. Completion shows up as a final-summary
 * card pushed by the runner, not as a tool response.
 */

import type { AgentPermissionCeiling } from "@/types/agent/permission-ceiling"
import type { WorkflowTriggeredFrom } from "@/types/workflow/visual"
import Dexie from "dexie"
import { executeDeployedWorkflow, WorkflowAdmissionError } from "./execution-authority"

export interface StartWorkflowFromIMInput {
  workflowId: string
  /** Free-form payload — surfaced to trigger-aware nodes as `$trigger.payload`. */
  runParams?: Record<string, unknown>
  /** IM origin metadata. Required so progress fans back to the right chat. */
  triggeredFrom: WorkflowTriggeredFrom
  /** Optional external AbortSignal — propagates to the orchestrator. */
  signal?: AbortSignal
  /** Parent IM ceiling inherited by dynamic agent nodes and nested runs. */
  permissionCeiling?: AgentPermissionCeiling
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
  let admittedRunId: string | undefined
  let markPersisted: () => void = () => undefined
  const persisted = new Promise<void>((resolve) => {
    markPersisted = resolve
  })
  const execution = Dexie.ignoreTransaction(() =>
    executeDeployedWorkflow({
      workflowId: input.workflowId,
      entrypoint: "skill",
      caller: input.triggeredFrom.initiator?.principalId ?? "im",
      triggerKind: "trigger.manual",
      payload: input.runParams ?? {},
      triggerBinding: {
        adapterId: input.triggeredFrom.adapterId,
        conversationKey: input.triggeredFrom.conversationKey,
        sessionId: input.triggeredFrom.sessionId,
        ...(input.triggeredFrom.characterId
          ? { characterId: input.triggeredFrom.characterId }
          : {}),
      },
      ...(input.permissionCeiling
        ? {
            securityContext: {
              piiEgressRequired: true,
              sourceTriggerKind: "trigger.manual" as const,
              permissionCeiling: input.permissionCeiling,
            },
          }
        : {}),
      signal: input.signal,
      triggeredBy: input.triggeredFrom,
      onAdmitted: (runId) => {
        admittedRunId = runId
      },
      onPersisted: markPersisted,
    })
  )
  // A valid run resolves `persisted` immediately after its durable row lands.
  // A validation/preflight failure can finish before creating that row, so the
  // execution promise is the second race arm and prevents this handoff from
  // hanging. The race also owns the rejection handler for the detached run.
  try {
    await Promise.race([persisted, execution.then(() => undefined)])
  } catch (error) {
    if (error instanceof WorkflowAdmissionError && error.code === "deployment-not-found") {
      return { ok: false, reason: "workflow-not-found", workflowId: input.workflowId }
    }
    throw error
  }

  if (!admittedRunId) admittedRunId = (await execution).runId
  return { ok: true, runId: admittedRunId }
}
