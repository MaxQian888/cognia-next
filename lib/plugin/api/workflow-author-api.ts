/** Host-governed workflow authoring and execution façade for plugins. */

import type { Viewport } from "@xyflow/react"

import type { PluginToolDef } from "@/types/plugin"
import type { WorkflowNodeData, WorkflowNodeKind } from "@/types/workflow/visual"
import type { VisualWorkflow, WorkflowTriggeredFrom } from "@/types/workflow/visual"
import type {
  CallbackActorScope,
  ConnectorCallbackBindingKind,
} from "@/types/connectors/interaction"
import type { A2UISegmentContent } from "@/types/connectors/segment"
import type { RFWorkflowEdge, RFWorkflowNode } from "@/lib/workflow/editor/react-flow-converter"
import type { NodeValidationResult } from "@/lib/workflow/nodes/validate-params"
import type { LastRunSummary } from "@/lib/workflow/runtime/last-run-summary"
import type { ProposalOp } from "@/lib/workflow/editor/proposal-types"
import type { ProposalPayload } from "@/lib/workflow/editor/proposal-store"
import type { AutoLayoutDirection } from "@/lib/workflow/editor/auto-layout"
import type { ExplainedLastRun, ExplainedValidation } from "@/lib/workflow/runtime/error-explainer"
import type {
  CopilotSlotValues,
  MaterializeResult,
  WorkflowCopilotTemplate,
} from "@/lib/workflow/copilot-templates"
import type { NodeCatalogEntry } from "@/lib/workflow/nodes/catalog"
import type { FindWorkflowByNameResult, WorkflowSummary } from "@/lib/workflow/library/lookup"
import type { RunWorkflowInput, RunWorkflowResult } from "@/lib/workflow/runtime/orchestrator"
import type { RunWorkflowTypedResult } from "@/lib/workflow/publish/run-workflow-typed-tool"
import type { WorkflowWaitEvent } from "@/types/workflow/waitpoint"

import { getEditorStore, listEditorStores } from "@/lib/workflow/editor/store-registry"
import { useProposalStore } from "@/lib/workflow/editor/proposal-store"
import { autoLayout, applyAutoLayoutPositions } from "@/lib/workflow/editor/auto-layout"
import { explainLastRun, explainValidation } from "@/lib/workflow/runtime/error-explainer"
import { listCopilotTemplates, materializeCopilotTemplate } from "@/lib/workflow/copilot-templates"
import {
  NODE_CATALOG,
  getPluginCatalogSnapshot,
  nodeCatalogEntry,
} from "@/lib/workflow/nodes/catalog"
import { refreshAllWorkflowTemplateWarnings } from "@/lib/plugin/registries/workflow-template-registry"
import { runWorkflow } from "@/lib/workflow/runtime/orchestrator"
import { executeRunWorkflowTyped } from "@/lib/workflow/publish/run-workflow-typed-tool"
import {
  WORKFLOW_RUNNER_TOOL_DEFINITION,
  WORKFLOW_RUNNER_TOOL_NAME,
} from "@/lib/workflow/publish/runner-tool"
import {
  findWorkflowById,
  findWorkflowByName,
  listWorkflowSummaries,
} from "@/lib/workflow/library/lookup"
import {
  approvalActorScope,
  resolveWorkflowTriggerOrigin,
} from "@/lib/workflow/runtime/trigger-origin"
import { recordCallbackBinding } from "@/lib/connectors/adapters/_shared/a2ui-mapper"
import { buildApprovalSurface } from "@/lib/connectors/a2ui-bridge/workflow-to-a2ui"
import { createWorkflowWaitEvent, emitWorkflowWaitEvent } from "@/lib/db/workflow-waitpoints"

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

function snapshotEditor(workflowId: string): PluginWorkflowEditorSnapshot | undefined {
  const store = getEditorStore(workflowId)
  if (!store) return undefined
  const state = store.getState()
  return {
    workflowId,
    workflow: structuredClone(state.toWorkflow()),
    baseWorkflow: structuredClone(state.baseWorkflow),
    nodes: structuredClone(state.nodes),
    edges: structuredClone(state.edges),
    viewport: structuredClone(state.viewport),
    selectedNodeIds: [...state.selectedNodeIds],
    selectedEdgeIds: [...state.selectedEdgeIds],
    runStatusByStepId: structuredClone(state.runStatusByStepId),
    validationByStepId: structuredClone(state.validationByStepId),
    lastRunByStepId: structuredClone(state.lastRunByStepId),
  }
}

function requireEditor(workflowId: string) {
  const store = getEditorStore(workflowId)
  if (!store) throw new Error(`Workflow editor for "${workflowId}" is not open.`)
  return store
}

export function createWorkflowAuthorAPI(): PluginWorkflowAuthorAPI {
  return {
    resolveEditor(workflowId) {
      if (workflowId) {
        const editor = snapshotEditor(workflowId)
        return editor
          ? { ok: true, editor }
          : { ok: false, reason: "not-open", requestedId: workflowId }
      }
      const open = listEditorStores()
      if (open.length === 0) return { ok: false, reason: "not-open" }
      if (open.length > 1) {
        return { ok: false, reason: "ambiguous", openIds: open.map((entry) => entry.workflowId) }
      }
      return { ok: true, editor: snapshotEditor(open[0].workflowId)! }
    },

    mutateEditor(workflowId, command) {
      const state = requireEditor(workflowId).getState()
      switch (command.kind) {
        case "add-node":
          return {
            kind: command.kind,
            nodeId: state.addNode(command.nodeKind, command.position, command.overrides),
          }
        case "remove-nodes":
          state.removeNodes(command.ids)
          return { kind: command.kind }
        case "remove-edges":
          state.removeEdges(command.ids)
          return { kind: command.kind }
        case "connect":
          return { kind: command.kind, edgeId: state.connect(command) }
        case "update-edge":
          return { kind: command.kind, updated: state.updateEdgeData(command.id, command.patch) }
        case "update-node":
          state.updateNodeData(command.id, command.patch)
          return { kind: command.kind }
        case "revalidate-node":
          return { kind: command.kind, validation: state.revalidateNode(command.id) }
        case "apply-proposal":
          return {
            kind: command.kind,
            ...state.applyProposalOps(command.ops, command.expectedRevision),
          }
        case "set-nodes":
          state.setNodes(command.nodes)
          return { kind: command.kind }
        case "group-nodes":
          return { kind: command.kind, groupId: state.groupSelected(command.ids) }
        case "select-nodes":
          state.setSelectedNodes(command.ids)
          return { kind: command.kind }
        case "set-viewport":
          state.setViewport(command.viewport)
          return { kind: command.kind }
        case "pulse-node":
          state.pulseNode(command.id, command.durationMs)
          return { kind: command.kind }
      }
    },

    stageProposal(input) {
      return useProposalStore.getState().openProposal(input.workflowId, input)
    },

    async autoLayoutEditor(workflowId, direction) {
      const state = requireEditor(workflowId).getState()
      const positions = await autoLayout(state.nodes, state.edges, { direction })
      const next = applyAutoLayoutPositions(state.nodes, positions)
      state.setNodes(next)
      return next.length
    },

    explainEditorValidation(workflowId) {
      const state = requireEditor(workflowId).getState()
      return explainValidation(
        state.validationByStepId,
        state.nodes.map((node) => ({
          id: node.id,
          label: node.data.label ?? node.id,
          kind: node.data.kind,
        }))
      )
    },

    explainEditorLastRun(workflowId) {
      const state = requireEditor(workflowId).getState()
      return explainLastRun(
        state.lastRunByStepId,
        state.nodes.map((node) => ({
          id: node.id,
          label: node.data.label ?? node.id,
          kind: node.data.kind,
        }))
      )
    },

    listCopilotTemplates,
    materializeCopilotTemplate,
    listNodeCatalog: () => [...NODE_CATALOG, ...getPluginCatalogSnapshot()],
    getNodeCatalogEntry: (kind) => nodeCatalogEntry(kind as WorkflowNodeKind),
    refreshTemplateWarnings: refreshAllWorkflowTemplateWarnings,
    runWorkflow,
    executeRunWorkflowTyped,
    getRunnerToolDefinition: () => ({
      name: WORKFLOW_RUNNER_TOOL_NAME,
      definition: WORKFLOW_RUNNER_TOOL_DEFINITION,
    }),
    listWorkflowSummaries,
    findWorkflowByName,
    findWorkflowById,
    resolveTriggerOrigin: resolveWorkflowTriggerOrigin,
    approvalActorScope,
    recordCallbackBinding: async (input) => {
      await recordCallbackBinding(input)
    },
    buildApprovalSurface,
    emitWaitEvent: (input) => emitWorkflowWaitEvent(createWorkflowWaitEvent(input)),
  }
}
