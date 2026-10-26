/** Host-governed workflow authoring and execution façade for plugins. */

import type { WorkflowNodeKind } from "@/types/workflow/visual"
import type { NodeCatalogEntry } from "@/lib/workflow/nodes/catalog"

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
import { defaultTypeVersionFor } from "@/lib/workflow/editor/node-handles"
import { KNOWN_KINDS, paramsJsonSchemaFor } from "@/lib/workflow/nodes/params-schemas"
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
import type {
  PluginWorkflowAuthorAPI,
  PluginWorkflowEditorSnapshot,
} from "@cognia/plugin-contract/lib/plugin/api/workflow-author-api"
export type {
  EmitPluginWorkflowWaitEventInput,
  PluginWorkflowAuthorAPI,
  PluginWorkflowEditorCommand,
  PluginWorkflowEditorMutationResult,
  PluginWorkflowEditorResolution,
  PluginWorkflowEditorSnapshot,
  RecordPluginWorkflowCallbackInput,
  StageWorkflowProposalInput,
} from "@cognia/plugin-contract/lib/plugin/api/workflow-author-api"

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
    listNodeCatalog: () => [
      ...NODE_CATALOG.map(authoringCatalogEntry),
      ...getPluginCatalogSnapshot(),
    ],
    getNodeCatalogEntry: (kind) =>
      authoringCatalogEntry(nodeCatalogEntry(kind as WorkflowNodeKind)),
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

/** Keep inspector presentation schemas separate from the versioned authoring contract. */
function authoringCatalogEntry(entry: NodeCatalogEntry): NodeCatalogEntry {
  if (entry.pluginId || !KNOWN_KINDS.includes(entry.kind)) return entry
  const typeVersion = defaultTypeVersionFor(entry.kind)
  return { ...entry, typeVersion, paramsSchema: paramsJsonSchemaFor(entry.kind, typeVersion) }
}
