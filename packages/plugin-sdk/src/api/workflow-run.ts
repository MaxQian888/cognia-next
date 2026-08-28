/**
 * Plugin SDK — `workflow-run` capability surface: starting a workflow, and
 * everything a run started by a plugin has to carry with it.
 *
 * `runWorkflow` is the host orchestrator — the same entry point the editor's
 * Run button uses, so a plugin-started run gets the same admission, execution
 * slot, waitpoints and run record.
 *
 * `resolveWorkflowTriggerOrigin()` is the part that must NOT be
 * reimplemented. A run started from inside an IM conversation carries the
 * verified human driving the turn, and that initiator feeds the actor scope on
 * every approval the run raises — the callback guard only lets that person (or
 * a configured operator) tap Approve. A second derivation of it is a second
 * chance to widen the scope by accident.
 */

export { runWorkflow } from "@/lib/workflow/runtime/orchestrator"

export {
  approvalActorScope,
  resolveWorkflowTriggerOrigin,
} from "@/lib/workflow/runtime/trigger-origin"

export { publishWorkflow } from "@/lib/workflow/publish/publish-workflow"
export { executeRunWorkflowTyped } from "@/lib/workflow/publish/run-workflow-typed-tool"
export {
  WORKFLOW_RUNNER_TOOL_DEFINITION,
  WORKFLOW_RUNNER_TOOL_NAME,
} from "@/lib/workflow/publish/runner-tool"

/**
 * Index-level lookup: id, name, description. Resolving a workflow by the name
 * a user typed is ambiguous often enough that the result is a discriminated
 * union rather than a maybe — a copilot that picks silently picks wrong.
 */
export {
  findWorkflowById,
  findWorkflowByName,
  listWorkflowSummaries,
  resolveWorkflowByNameOrId,
} from "@/lib/workflow/library/lookup"

export type { FindWorkflowByNameResult, WorkflowSummary } from "@/lib/workflow/library/lookup"

export { createWorkflow } from "@/lib/db/workflows"

/** Waitpoints — how a paused run is resumed by an approval or an event. */
export { createWorkflowWaitEvent, emitWorkflowWaitEvent } from "@/lib/db/workflow-waitpoints"

/**
 * Rendering an approval into the conversation that started the run, and
 * binding the callback so the tap comes back to the right waitpoint.
 */
export { buildApprovalSurface } from "@/lib/connectors/a2ui-bridge/workflow-to-a2ui"
export { recordCallbackBinding } from "@/lib/connectors/adapters/_shared/a2ui-mapper"

export type { A2UISegmentContent } from "@/types/connectors/segment"
export type { CallbackActorScope } from "@/types/connectors/interaction"
