/**
 * The plugin contract's share of `lib/plugin/api/workflow-author-api.ts`, which re-exports these.
 */
import type { A2UISegmentContent } from "../../../types/connectors/segment"
import type { AutoLayoutDirection } from "../../workflow/editor/auto-layout"
import type {
  CallbackActorScope,
  ConnectorCallbackBindingKind,
} from "../../../types/connectors/interaction"
import type {
  CopilotSlotValues,
  WorkflowCopilotTemplate,
} from "../../workflow/copilot-templates/types"
import type { ExplainedLastRun, ExplainedValidation } from "../../workflow/runtime/error-explainer"
import type { FindWorkflowByNameResult, WorkflowSummary } from "../../workflow/library/lookup"
import type { LastRunSummary } from "../../workflow/runtime/last-run-summary"
import type { MaterializeResult } from "../../workflow/copilot-templates/index"
import type { NodeCatalogEntry } from "../../workflow/nodes/catalog"
import type { NodeValidationResult } from "../../workflow/nodes/validate-params"
import type { PluginToolDef } from "../../../types/plugin"
import type { ProposalOp } from "../../workflow/editor/proposal-types"
import type { ProposalPayload } from "../../workflow/editor/proposal-store"
import type { RFWorkflowEdge, RFWorkflowNode } from "../../workflow/editor/react-flow-converter"
import type { RunWorkflowInput, RunWorkflowResult } from "../../workflow/runtime/orchestrator"
import type { RunWorkflowTypedResult } from "../../workflow/publish/run-workflow-typed-tool"
import type { Viewport } from "@xyflow/react"
import type {
  VisualWorkflow,
  WorkflowNodeData,
  WorkflowNodeKind,
  WorkflowTriggeredFrom,
} from "../../../types/workflow/visual"
import type { WorkflowWaitEvent } from "../../../types/workflow/waitpoint"

export interface PluginWorkflowEditorSnapshot {
  workflowId: string
  workflow: VisualWorkflow
  baseWorkflow: VisualWorkflow
  nodes: RFWorkflowNode[]
  edges: RFWorkflowEdge[]
  viewport: Viewport
  selectedNodeIds: string[]
  selectedEdgeIds: string[]
  runStatusByStepId: Record<string, string>
  validationByStepId: Record<string, NodeValidationResult>
  lastRunByStepId: Record<string, LastRunSummary>
}

export type PluginWorkflowEditorResolution =
  | { ok: true; editor: PluginWorkflowEditorSnapshot }
  | { ok: false; reason: "not-open"; requestedId?: string }
  | { ok: false; reason: "ambiguous"; openIds: string[] }

export type PluginWorkflowEditorCommand =
  | {
      kind: "add-node"
      nodeKind: WorkflowNodeKind
      position: { x: number; y: number }
      overrides?: Partial<WorkflowNodeData>
    }
  | { kind: "remove-nodes"; ids: string[] }
  | { kind: "remove-edges"; ids: string[] }
  | {
      kind: "connect"
      source: string
      target: string
      sourceHandle?: string
      targetHandle?: string
    }
  | { kind: "update-edge"; id: string; patch: Record<string, unknown> }
  | { kind: "update-node"; id: string; patch: Partial<WorkflowNodeData> }
  | { kind: "revalidate-node"; id: string }
  | { kind: "apply-proposal"; ops: ReadonlyArray<ProposalOp>; expectedRevision?: string }
  | { kind: "set-nodes"; nodes: RFWorkflowNode[] }
  | { kind: "group-nodes"; ids: string[] }
  | { kind: "select-nodes"; ids: string[] }
  | { kind: "set-viewport"; viewport: Viewport }
  | { kind: "pulse-node"; id: string; durationMs: number }

export type PluginWorkflowEditorMutationResult =
  | { kind: "add-node"; nodeId: string }
  | { kind: "connect"; edgeId: string | null }
  | { kind: "update-edge"; updated: boolean }
  | { kind: "revalidate-node"; validation: NodeValidationResult }
  | {
      kind: "apply-proposal"
      applied: number
      firstError?: string
      stale?: boolean
      currentRevision?: string
    }
  | { kind: "group-nodes"; groupId: string | null }
  | {
      kind: Exclude<
        PluginWorkflowEditorCommand["kind"],
        | "add-node"
        | "connect"
        | "update-edge"
        | "revalidate-node"
        | "apply-proposal"
        | "group-nodes"
      >
    }

export interface StageWorkflowProposalInput {
  proposalId: string
  workflowId: string
  summary: string
  ops: ReadonlyArray<ProposalOp>
  baseRevision: string
}

export interface EmitPluginWorkflowWaitEventInput {
  key: string
  correlationId?: string
  source: string
  data?: unknown
}

export interface RecordPluginWorkflowCallbackInput {
  adapterId: string
  actionId: string
  kind: ConnectorCallbackBindingKind
  surfaceId: string
  componentId?: string
  conversationKey?: string
  payload: Record<string, unknown>
  actorScope: CallbackActorScope
  allowedActions?: string[]
}

export interface PluginWorkflowAuthorAPI {
  resolveEditor(workflowId?: string): PluginWorkflowEditorResolution
  mutateEditor(
    workflowId: string,
    command: PluginWorkflowEditorCommand
  ): PluginWorkflowEditorMutationResult
  stageProposal(input: StageWorkflowProposalInput): ProposalPayload
  autoLayoutEditor(workflowId: string, direction?: AutoLayoutDirection): Promise<number>
  explainEditorValidation(workflowId: string): ExplainedValidation[]
  explainEditorLastRun(workflowId: string): ExplainedLastRun
  listCopilotTemplates(): readonly WorkflowCopilotTemplate[]
  materializeCopilotTemplate(templateId: string, slots: CopilotSlotValues): MaterializeResult
  listNodeCatalog(): readonly NodeCatalogEntry[]
  getNodeCatalogEntry(kind: string): NodeCatalogEntry
  refreshTemplateWarnings(): void
  runWorkflow(input: RunWorkflowInput): Promise<RunWorkflowResult>
  executeRunWorkflowTyped(args: Record<string, unknown>): Promise<RunWorkflowTypedResult>
  getRunnerToolDefinition(): { name: string; definition: PluginToolDef }
  listWorkflowSummaries(limit?: number): Promise<WorkflowSummary[]>
  findWorkflowByName(name: string): Promise<FindWorkflowByNameResult>
  findWorkflowById(workflowId: string): Promise<WorkflowSummary | undefined>
  resolveTriggerOrigin(sessionId?: string): Promise<WorkflowTriggeredFrom | null>
  approvalActorScope(triggeredFrom: WorkflowTriggeredFrom): CallbackActorScope
  recordCallbackBinding(input: RecordPluginWorkflowCallbackInput): Promise<void>
  buildApprovalSurface(input: {
    bindingId: string
    workflowName: string
    summary?: string
  }): A2UISegmentContent
  emitWaitEvent(input: EmitPluginWorkflowWaitEventInput): Promise<WorkflowWaitEvent>
}
