import { createWorkflowAuthorAPI } from "./workflow-author-api"

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

jest.mock("@/lib/workflow/editor/store-registry", () => ({
  getEditorStore: jest.fn(),
  listEditorStores: jest.fn(),
}))
jest.mock("@/lib/workflow/editor/proposal-store", () => ({
  useProposalStore: { getState: jest.fn() },
}))
jest.mock("@/lib/workflow/editor/auto-layout", () => ({
  autoLayout: jest.fn(),
  applyAutoLayoutPositions: jest.fn(),
}))
jest.mock("@/lib/workflow/runtime/error-explainer", () => ({
  explainLastRun: jest.fn(),
  explainValidation: jest.fn(),
}))
jest.mock("@/lib/workflow/copilot-templates", () => ({
  listCopilotTemplates: jest.fn(),
  materializeCopilotTemplate: jest.fn(),
}))
jest.mock("@/lib/workflow/nodes/catalog", () => ({
  NODE_CATALOG: [{ kind: "start" }],
  getPluginCatalogSnapshot: jest.fn(),
  nodeCatalogEntry: jest.fn(),
}))
jest.mock("@/lib/plugin/registries/workflow-template-registry", () => ({
  refreshAllWorkflowTemplateWarnings: jest.fn(),
}))
jest.mock("@/lib/workflow/runtime/orchestrator", () => ({ runWorkflow: jest.fn() }))
jest.mock("@/lib/workflow/publish/run-workflow-typed-tool", () => ({
  executeRunWorkflowTyped: jest.fn(),
}))
jest.mock("@/lib/workflow/library/lookup", () => ({
  findWorkflowById: jest.fn(),
  findWorkflowByName: jest.fn(),
  listWorkflowSummaries: jest.fn(),
}))
jest.mock("@/lib/workflow/runtime/trigger-origin", () => ({
  approvalActorScope: jest.fn(),
  resolveWorkflowTriggerOrigin: jest.fn(),
}))
jest.mock("@/lib/connectors/adapters/_shared/a2ui-mapper", () => ({
  recordCallbackBinding: jest.fn(),
}))
jest.mock("@/lib/connectors/a2ui-bridge/workflow-to-a2ui", () => ({
  buildApprovalSurface: jest.fn(),
}))
jest.mock("@/lib/db/workflow-waitpoints", () => ({
  createWorkflowWaitEvent: jest.fn(),
  emitWorkflowWaitEvent: jest.fn(),
}))

const mockGetEditorStore = jest.mocked(getEditorStore)
const mockListEditorStores = jest.mocked(listEditorStores)

function createState() {
  const workflow = {
    id: "wf-1",
    schemaVersion: 1,
    name: "Workflow",
    nodes: [],
    edges: [],
    settings: {},
    tags: [],
    createdAt: 1,
    updatedAt: 2,
  }
  return {
    workflowId: "wf-1",
    baseWorkflow: workflow,
    nodes: [{ id: "node-1", data: { kind: "start", label: "Start" }, position: { x: 0, y: 0 } }],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    selectedNodeIds: ["node-1"],
    selectedEdgeIds: [],
    runStatusByStepId: { "node-1": "succeeded" },
    validationByStepId: {},
    lastRunByStepId: {},
    toWorkflow: jest.fn(() => workflow),
    addNode: jest.fn(() => "node-2"),
    removeNodes: jest.fn(),
    removeEdges: jest.fn(),
    connect: jest.fn(() => "edge-1"),
    updateEdgeData: jest.fn(() => true),
    updateNodeData: jest.fn(),
    revalidateNode: jest.fn(() => ({ valid: true, errors: [] })),
    applyProposalOps: jest.fn(() => ({ applied: 2 })),
    setNodes: jest.fn(),
    groupSelected: jest.fn(() => "group-1"),
    setSelectedNodes: jest.fn(),
    setViewport: jest.fn(),
    pulseNode: jest.fn(),
  }
}

function installEditor(state = createState()) {
  const store = { getState: jest.fn(() => state) }
  mockGetEditorStore.mockImplementation((id) => (id === "wf-1" ? (store as never) : null))
  mockListEditorStores.mockReturnValue([{ workflowId: "wf-1", store: store as never }])
  return { state, store }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockGetEditorStore.mockReturnValue(null)
  mockListEditorStores.mockReturnValue([])
})

describe("createWorkflowAuthorAPI", () => {
  it("resolves only an unambiguous editor and returns a detached snapshot", () => {
    const api = createWorkflowAuthorAPI()
    expect(api.resolveEditor("missing")).toEqual({
      ok: false,
      reason: "not-open",
      requestedId: "missing",
    })
    expect(api.resolveEditor()).toEqual({ ok: false, reason: "not-open" })

    const { state, store } = installEditor()
    const resolved = api.resolveEditor("wf-1")
    expect(resolved).toMatchObject({ ok: true, editor: { workflowId: "wf-1" } })
    if (resolved.ok) {
      resolved.editor.nodes[0].position.x = 99
      expect(state.nodes[0].position.x).toBe(0)
    }
    expect(api.resolveEditor()).toMatchObject({ ok: true, editor: { workflowId: "wf-1" } })

    mockListEditorStores.mockReturnValue([
      { workflowId: "wf-1", store: store as never },
      { workflowId: "wf-2", store: store as never },
    ])
    expect(api.resolveEditor()).toEqual({
      ok: false,
      reason: "ambiguous",
      openIds: ["wf-1", "wf-2"],
    })
  })

  it("executes every supported editor command without exposing the live store", () => {
    const { state } = installEditor()
    const api = createWorkflowAuthorAPI()

    expect(
      api.mutateEditor("wf-1", {
        kind: "add-node",
        nodeKind: "trigger.manual",
        position: { x: 1, y: 2 },
      })
    ).toEqual({
      kind: "add-node",
      nodeId: "node-2",
    })
    expect(api.mutateEditor("wf-1", { kind: "remove-nodes", ids: ["node-1"] })).toEqual({
      kind: "remove-nodes",
    })
    expect(api.mutateEditor("wf-1", { kind: "remove-edges", ids: ["edge-1"] })).toEqual({
      kind: "remove-edges",
    })
    expect(
      api.mutateEditor("wf-1", { kind: "connect", source: "node-1", target: "node-2" })
    ).toEqual({
      kind: "connect",
      edgeId: "edge-1",
    })
    expect(
      api.mutateEditor("wf-1", { kind: "update-edge", id: "edge-1", patch: { label: "next" } })
    ).toEqual({
      kind: "update-edge",
      updated: true,
    })
    expect(
      api.mutateEditor("wf-1", { kind: "update-node", id: "node-1", patch: { label: "Begin" } })
    ).toEqual({ kind: "update-node" })
    expect(api.mutateEditor("wf-1", { kind: "revalidate-node", id: "node-1" })).toEqual({
      kind: "revalidate-node",
      validation: { valid: true, errors: [] },
    })
    expect(api.mutateEditor("wf-1", { kind: "apply-proposal", ops: [] })).toEqual({
      kind: "apply-proposal",
      applied: 2,
    })
    expect(api.mutateEditor("wf-1", { kind: "set-nodes", nodes: [] })).toEqual({
      kind: "set-nodes",
    })
    expect(api.mutateEditor("wf-1", { kind: "group-nodes", ids: ["node-1"] })).toEqual({
      kind: "group-nodes",
      groupId: "group-1",
    })
    expect(api.mutateEditor("wf-1", { kind: "select-nodes", ids: ["node-1"] })).toEqual({
      kind: "select-nodes",
    })
    expect(
      api.mutateEditor("wf-1", { kind: "set-viewport", viewport: { x: 1, y: 2, zoom: 2 } })
    ).toEqual({
      kind: "set-viewport",
    })
    expect(api.mutateEditor("wf-1", { kind: "pulse-node", id: "node-1", durationMs: 100 })).toEqual(
      { kind: "pulse-node" }
    )
    expect(state.addNode).toHaveBeenCalled()
    expect(state.pulseNode).toHaveBeenCalledWith("node-1", 100)
    expect(() => api.mutateEditor("missing", { kind: "remove-nodes", ids: [] })).toThrow(
      'Workflow editor for "missing" is not open.'
    )
  })

  it("governs editor helpers and delegates non-editor workflow capabilities", async () => {
    const { state } = installEditor()
    const proposal = { proposalId: "proposal-1" }
    const openProposal = jest.fn(() => proposal)
    jest.mocked(useProposalStore.getState).mockReturnValue({ openProposal } as never)
    jest.mocked(autoLayout).mockResolvedValue({ "node-1": { x: 10, y: 20 } })
    jest.mocked(applyAutoLayoutPositions).mockReturnValue(state.nodes as never)
    jest.mocked(explainValidation).mockReturnValue([{ nodeId: "node-1" }] as never)
    jest.mocked(explainLastRun).mockReturnValue({ status: "succeeded" } as never)
    jest.mocked(listCopilotTemplates).mockReturnValue([{ id: "template-1" }] as never)
    jest.mocked(materializeCopilotTemplate).mockReturnValue({ workflow: { id: "wf-new" } } as never)
    jest.mocked(getPluginCatalogSnapshot).mockReturnValue([{ kind: "plugin-node" }] as never)
    jest.mocked(nodeCatalogEntry).mockReturnValue({ kind: "start" } as never)

    const api = createWorkflowAuthorAPI()
    expect(
      api.stageProposal({
        proposalId: "proposal-1",
        workflowId: "wf-1",
        summary: "Change",
        ops: [],
        baseRevision: "revision-1",
      })
    ).toBe(proposal)
    expect(await api.autoLayoutEditor("wf-1", "LR")).toBe(1)
    expect(state.setNodes).toHaveBeenCalledWith(state.nodes)
    expect(api.explainEditorValidation("wf-1")).toEqual([{ nodeId: "node-1" }])
    expect(api.explainEditorLastRun("wf-1")).toEqual({ status: "succeeded" })
    expect(api.listCopilotTemplates()).toEqual([{ id: "template-1" }])
    expect(api.materializeCopilotTemplate("template-1", {} as never)).toEqual({
      workflow: { id: "wf-new" },
    })
    expect(api.listNodeCatalog()).toEqual([...NODE_CATALOG, { kind: "plugin-node" }])
    expect(api.getNodeCatalogEntry("start")).toEqual({ kind: "start" })
    api.refreshTemplateWarnings()
    expect(refreshAllWorkflowTemplateWarnings).toHaveBeenCalledTimes(1)
  })

  it("delegates execution, discovery, connector, and wait-event operations", async () => {
    const runResult = { status: "completed" }
    const typedResult = { ok: true }
    const summaries = [{ id: "wf-1" }]
    const nameResult = { kind: "found", workflow: summaries[0] }
    const trigger = { type: "manual" }
    const actor = { kind: "user" }
    const surface = { type: "a2ui" }
    const waitEvent = { id: "event-1" }
    jest.mocked(runWorkflow).mockResolvedValue(runResult as never)
    jest.mocked(executeRunWorkflowTyped).mockResolvedValue(typedResult as never)
    jest.mocked(listWorkflowSummaries).mockResolvedValue(summaries as never)
    jest.mocked(findWorkflowByName).mockResolvedValue(nameResult as never)
    jest.mocked(findWorkflowById).mockResolvedValue(summaries[0] as never)
    jest.mocked(resolveWorkflowTriggerOrigin).mockResolvedValue(trigger as never)
    jest.mocked(approvalActorScope).mockReturnValue(actor as never)
    jest.mocked(recordCallbackBinding).mockResolvedValue(undefined)
    jest.mocked(buildApprovalSurface).mockReturnValue(surface as never)
    jest.mocked(createWorkflowWaitEvent).mockReturnValue(waitEvent as never)
    jest.mocked(emitWorkflowWaitEvent).mockResolvedValue(waitEvent as never)

    const api = createWorkflowAuthorAPI()
    expect(await api.runWorkflow({ workflowId: "wf-1" } as never)).toBe(runResult)
    expect(await api.executeRunWorkflowTyped({ name: "Workflow" })).toBe(typedResult)
    expect(api.getRunnerToolDefinition()).toEqual({
      name: WORKFLOW_RUNNER_TOOL_NAME,
      definition: WORKFLOW_RUNNER_TOOL_DEFINITION,
    })
    expect(await api.listWorkflowSummaries(5)).toBe(summaries)
    expect(await api.findWorkflowByName("Workflow")).toBe(nameResult)
    expect(await api.findWorkflowById("wf-1")).toBe(summaries[0])
    expect(await api.resolveTriggerOrigin("session-1")).toBe(trigger)
    expect(api.approvalActorScope(trigger as never)).toBe(actor)

    const binding = {
      adapterId: "adapter",
      actionId: "action",
      kind: "approval",
      surfaceId: "surface",
      componentId: "component",
      payload: {},
      actorScope: actor,
    }
    await api.recordCallbackBinding(binding as never)
    expect(recordCallbackBinding).toHaveBeenCalledWith(binding)
    expect(api.buildApprovalSurface({ bindingId: "binding", workflowName: "Workflow" })).toBe(
      surface
    )
    expect(await api.emitWaitEvent({ key: "ready", source: "plugin" })).toBe(waitEvent)
    expect(emitWorkflowWaitEvent).toHaveBeenCalledWith(waitEvent)
  })
})
