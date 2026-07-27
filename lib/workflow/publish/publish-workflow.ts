/**
 * Publish a workflow as a typed callable unit (D5) — the n8n `ToolWorkflow` /
 * Dify `WORKFLOW` provider pattern.
 *
 * The declared interface (input/output JSON Schemas) is authored on the canvas:
 * the `trigger.manual` node's `inputSchema` param and the `io.output` node's
 * `outputSchema` param. Publishing derives `workflow.interface` from those,
 * stamps `workflow.published`, and registers a skill-catalog entry of
 * `kind:"workflow"` whose body points the model at the typed agent tool
 * (`wf_run_workflow_typed`). The same interface lets a typed `flow.subworkflow`
 * validate calls.
 *
 * Interface (schema) is declared separately from implementation (the graph);
 * callers see only the interface.
 */

import { WORKFLOW_RUNNER_TOOL_NAME } from "./runner-tool"
import {
  derivePublishedInterface,
  publishWorkflowLifecycle,
  toolNameForWorkflow,
  unpublishWorkflowLifecycle,
  workflowSkillCanonicalId,
  type PublishWorkflowResult,
} from "./publication-lifecycle"

export { WORKFLOW_RUNNER_TOOL_NAME }
export { derivePublishedInterface, toolNameForWorkflow, workflowSkillCanonicalId }
export type PublishResult = PublishWorkflowResult

/**
 * Publish (or re-publish) the workflow. Idempotent: re-publishing refreshes the
 * derived interface, the publication timestamp, and the skill entry.
 */
export async function publishWorkflow(workflowId: string, at: number): Promise<PublishResult> {
  return publishWorkflowLifecycle(workflowId, at)
}

/** Unpublish: clear the publication and drop the backing skill entry. */
export async function unpublishWorkflow(workflowId: string): Promise<void> {
  await unpublishWorkflowLifecycle(workflowId)
}
