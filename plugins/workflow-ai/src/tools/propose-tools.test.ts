/**
 * @jest-environment jsdom
 * @cognia-host-integration-test
 */
import {
  listEditorStores,
  registerEditorStore,
  unregisterEditorStore,
} from "@/lib/workflow/editor/store-registry"
import { createEditorStore } from "@/lib/workflow/editor/store"
import { useProposalStore } from "@/lib/workflow/editor/proposal-store"
import { createWorkflowAuthorAPI } from "@/lib/plugin/api/workflow-author-api"
import type { VisualWorkflow } from "@cognia/plugin-sdk"
import type { PluginTool, PluginToolContext } from "@cognia/plugin-sdk"
import { buildProposeTools, validateProposalOps } from "./propose-tools"
import { configureWorkflowApi } from "../store-bridge"

function workflow(id: string): VisualWorkflow {
  return {
    id,
    schemaVersion: 1,
    name: id,
    nodes: [],
    edges: [],
    settings: {
      errorPolicy: "stop",
      timeoutMs: 60_000,
      concurrency: 1,
      retryDefaults: { attempts: 3, backoff: "exponential", baseMs: 1000, maxMs: 30_000 },
    },
    tags: [],
    createdAt: 0,
    updatedAt: 0,
  }
}

const EMPTY_CTX: PluginToolContext = { config: {} }

function findTool(tools: PluginTool[], name: string): PluginTool {
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error(`Tool not found: ${name}`)
  return t
}

beforeEach(() => {
  configureWorkflowApi(createWorkflowAuthorAPI() as never)
  for (const { workflowId } of listEditorStores()) unregisterEditorStore(workflowId)
  for (const id of Object.keys(useProposalStore.getState().entries))
    useProposalStore.getState().clearProposalsFor(id)
})

describe("validateProposalOps", () => {
  it("accepts a chain that adds two nodes then connects them", () => {
    const result = validateProposalOps(
      [
        { type: "add_node", nodeId: "n_a", kind: "trigger.manual", position: { x: 0, y: 0 } },
        {
          type: "add_node",
          nodeId: "n_b",
          kind: "ai.prompt",
          position: { x: 200, y: 0 },
        },
        { type: "connect_edge", edgeId: "e_ab", source: "n_a", target: "n_b" },
      ],
      { nodeIds: new Set(), edgeIds: new Set() }
    )
    expect(result).toBeNull()
  })

  it("rejects an add_node that collides with the existing graph", () => {
    const result = validateProposalOps(
      [
        {
          type: "add_node",
          nodeId: "n_existing",
          kind: "trigger.manual",
          position: { x: 0, y: 0 },
        },
      ],
      { nodeIds: new Set(["n_existing"]), edgeIds: new Set() }
    )
    expect(result).toMatch(/already exists/)
  })

  it("rejects a connect_edge that points at a non-existent node", () => {
    const result = validateProposalOps(
      [{ type: "connect_edge", edgeId: "e_1", source: "n_ghost", target: "n_existing" }],
      { nodeIds: new Set(["n_existing"]), edgeIds: new Set() }
    )
    expect(result).toMatch(/n_ghost.*does not exist/)
  })

  it("rejects a connect_edge after a remove_node took its source", () => {
    const result = validateProposalOps(
      [
        { type: "remove_node", nodeId: "n_existing" },
        { type: "connect_edge", edgeId: "e_1", source: "n_existing", target: "n_b" },
      ],
      { nodeIds: new Set(["n_existing", "n_b"]), edgeIds: new Set() }
    )
    expect(result).toMatch(/n_existing.*does not exist/)
  })

  it("rejects duplicate edge ids in the same batch", () => {
    const result = validateProposalOps(
      [
        { type: "add_node", nodeId: "n_a", kind: "trigger.manual", position: { x: 0, y: 0 } },
        {
          type: "add_node",
          nodeId: "n_b",
          kind: "ai.prompt",
          position: { x: 200, y: 0 },
        },
        { type: "connect_edge", edgeId: "e_dup", source: "n_a", target: "n_b" },
        { type: "connect_edge", edgeId: "e_dup", source: "n_b", target: "n_a" },
      ],
      { nodeIds: new Set(), edgeIds: new Set() }
    )
    expect(result).toMatch(/edge id "e_dup".*already exists/)
  })
})

describe("wf_propose_batch tool", () => {
  function setupStore(): void {
    const store = createEditorStore(workflow("wf_a"))
    registerEditorStore("wf_a", store)
  }

  it("opens a proposal in the proposal store and returns messageParts for the chat card", async () => {
    setupStore()
    const tool = findTool(buildProposeTools(), "wf_propose_batch")
    const result = (await tool.execute(
      {
        workflowId: "wf_a",
        summary: "Add parallel correctness + security analysts",
        ops: [
          { type: "add_node", nodeId: "n_a", kind: "trigger.manual", position: { x: 0, y: 0 } },
          { type: "add_node", nodeId: "n_b", kind: "ai.prompt", position: { x: 200, y: 0 } },
          { type: "connect_edge", edgeId: "e_ab", source: "n_a", target: "n_b" },
        ],
      },
      EMPTY_CTX
    )) as {
      ok: true
      workflowId: string
      proposalId: string
      summary: string
      opCount: { add: number; connect: number }
      messageParts: Array<{ type: string; proposalId: string }>
    }
    expect(result.ok).toBe(true)
    expect(result.workflowId).toBe("wf_a")
    expect(result.proposalId).toMatch(/^p_/)
    expect(result.opCount).toMatchObject({ add: 2, connect: 1 })
    expect(result.messageParts).toHaveLength(1)
    expect(result.messageParts[0].type).toBe("workflow-proposal")
    expect(result.messageParts[0].proposalId).toBe(result.proposalId)
    // Proposal should be retrievable from the store as "open".
    expect(useProposalStore.getState().statusOf(result.proposalId)).toBe("open")
  })

  it("rejects an empty ops array", async () => {
    setupStore()
    const tool = findTool(buildProposeTools(), "wf_propose_batch")
    const result = (await tool.execute(
      { workflowId: "wf_a", summary: "noop", ops: [] },
      EMPTY_CTX
    )) as { ok: false; error: { code: string } }
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe("missing-ops")
  })

  it("rejects a missing summary", async () => {
    setupStore()
    const tool = findTool(buildProposeTools(), "wf_propose_batch")
    const result = (await tool.execute(
      {
        workflowId: "wf_a",
        ops: [
          { type: "add_node", nodeId: "n_a", kind: "trigger.manual", position: { x: 0, y: 0 } },
        ],
      },
      EMPTY_CTX
    )) as { ok: false; error: { code: string } }
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe("missing-summary")
  })

  it("surfaces a structured invalid-op error for malformed ops", async () => {
    setupStore()
    const tool = findTool(buildProposeTools(), "wf_propose_batch")
    const result = (await tool.execute(
      {
        workflowId: "wf_a",
        summary: "broken",
        ops: [
          {
            type: "add_node",
            // missing 'nodeId' on purpose
            kind: "trigger.manual",
            position: { x: 0, y: 0 },
          },
        ],
      },
      EMPTY_CTX
    )) as { ok: false; error: { code: string; message: string } }
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe("invalid-op")
    expect(result.error.message).toMatch(/nodeId/)
  })

  it("rejects collision with existing node ids", async () => {
    const store = createEditorStore(workflow("wf_a"))
    store.getState().applyProposalOps([
      {
        type: "add_node",
        nodeId: "n_existing",
        kind: "trigger.manual",
        position: { x: 0, y: 0 },
      },
    ])
    registerEditorStore("wf_a", store)
    const tool = findTool(buildProposeTools(), "wf_propose_batch")
    const result = (await tool.execute(
      {
        workflowId: "wf_a",
        summary: "should fail",
        ops: [
          {
            type: "add_node",
            nodeId: "n_existing",
            kind: "ai.prompt",
            position: { x: 200, y: 0 },
          },
        ],
      },
      EMPTY_CTX
    )) as { ok: false; error: { code: string } }
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe("invalid-proposal")
  })

  it("returns editor-not-open when no editor is registered for the workflowId", async () => {
    const tool = findTool(buildProposeTools(), "wf_propose_batch")
    const result = (await tool.execute(
      {
        workflowId: "wf_missing",
        summary: "no editor",
        ops: [
          { type: "add_node", nodeId: "n_a", kind: "trigger.manual", position: { x: 0, y: 0 } },
        ],
      },
      EMPTY_CTX
    )) as { ok: false; error: { code: string } }
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe("editor-not-open")
  })
})
