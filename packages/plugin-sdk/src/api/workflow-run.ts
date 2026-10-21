/** Portable workflow execution contracts. Runtime calls live on `ctx.workflow`. */

export type {
  RunWorkflowInput,
  RunWorkflowResult,
} from "@cognia/plugin-contract/lib/workflow/runtime/orchestrator"
export type { RunWorkflowTypedResult } from "@cognia/plugin-contract/lib/workflow/publish/run-workflow-typed-tool"
export type {
  FindWorkflowByNameResult,
  WorkflowSummary,
} from "@cognia/plugin-contract/lib/workflow/library/lookup"
export type { A2UISegmentContent } from "@cognia/plugin-contract/types/connectors/segment"
export type { CallbackActorScope } from "@cognia/plugin-contract/types/connectors/interaction"
export type { WorkflowWaitEvent } from "@cognia/plugin-contract/types/workflow/waitpoint"
export {
  WORKFLOW_RUNNER_TOOL_DEFINITION,
  WORKFLOW_RUNNER_TOOL_NAME,
} from "@/lib/workflow/publish/runner-tool"
