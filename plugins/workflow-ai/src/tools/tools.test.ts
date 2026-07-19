/**
 * @jest-environment jsdom
 */
import {
  __resetRegistryForTesting,
  registerEditorStore,
} from "@/lib/workflow/editor/store-registry"
import { createEditorStore } from "@/lib/workflow/editor/store"
import type { VisualWorkflow } from "@/types/workflow/visual"
import type { PluginTool, PluginToolContext } from "@/types/plugin"
import { buildReadTools } from "./read-tools"
import { buildMutateTools } from "./mutate-tools"
import { buildLayoutTools } from "./layout-tools"

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
  __resetRegistryForTesting()
})

describe("read tools", () => {
  it("wf_read_graph returns nodes / edges / envelope for the registered store", async () => {
    const store = createEditorStore(workflow("wf_a"))
    store.getState().addNode("ai.prompt", { x: 10, y: 20 }, { label: "Greet" })
    registerEditorStore("wf_a", store)
    const tool = findTool(buildReadTools(), "wf_read_graph")
    const result = await tool.execute({ workflowId: "wf_a" }, EMPTY_CTX)
    expect(result).toMatchObject({
      ok: true,
      workflowId: "wf_a",
      envelope: { id: "wf_a", name: "wf_a" },
      nodes: [
        expect.objectContaining({
          kind: "ai.prompt",
          label: "Greet",
          position: { x: 10, y: 20 },
        }),
      ],
    })
  })

  it("wf_read_node returns full state and exposes runStatus / validation / lastRun", async () => {
    const store = createEditorStore(workflow("wf_a"))
    const id = store.getState().addNode("ai.prompt", { x: 0, y: 0 })
    store.getState().setRunStatus(id, "running")
    registerEditorStore("wf_a", store)
    const tool = findTool(buildReadTools(), "wf_read_node")
    const result = (await tool.execute({ nodeId: id }, EMPTY_CTX)) as {
      ok: true
      node: { runStatus: string; kind: string }
    }
    expect(result.ok).toBe(true)
    expect(result.node.runStatus).toBe("running")
    expect(result.node.kind).toBe("ai.prompt")
  })

  it("wf_read_node reports node-not-found for missing ids", async () => {
    registerEditorStore("wf_a", createEditorStore(workflow("wf_a")))
    const tool = findTool(buildReadTools(), "wf_read_node")
    const result = (await tool.execute({ nodeId: "nope" }, EMPTY_CTX)) as {
      ok: false
      error: { code: string }
    }
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe("node-not-found")
  })

  it("wf_read_selection returns the current selection ids", async () => {
    const store = createEditorStore(workflow("wf_a"))
    const id = store.getState().addNode("ai.prompt", { x: 0, y: 0 })
    store.getState().setSelectedNodes([id])
    registerEditorStore("wf_a", store)
    const tool = findTool(buildReadTools(), "wf_read_selection")
    const result = (await tool.execute({}, EMPTY_CTX)) as {
      ok: true
      selectedNodeIds: string[]
    }
    expect(result.selectedNodeIds).toEqual([id])
  })

  it("wf_get_validation_errors returns failing nodes", async () => {
    const store = createEditorStore(workflow("wf_a"))
    const id = store.getState().addNode("ai.prompt", { x: 0, y: 0 })
    // Force a validation entry — bypass the validator's "no errors → prune"
    // by writing directly.
    store.setState({
      validationByStepId: {
        [id]: {
          fields: { systemPrompt: { key: "required" } },
          summary: ["required"],
          hasErrors: true,
        },
      },
    })
    registerEditorStore("wf_a", store)
    const tool = findTool(buildReadTools(), "wf_get_validation_errors")
    const result = (await tool.execute({}, EMPTY_CTX)) as {
      ok: true
      failing: Array<{ nodeId: string; summary: string[] }>
    }
    expect(result.failing.length).toBe(1)
    expect(result.failing[0].nodeId).toBe(id)
  })
})

describe("mutate tools", () => {
  it("wf_add_node creates a node with authoredBy='ai' and triggers validation", async () => {
    const store = createEditorStore(workflow("wf_a"))
    registerEditorStore("wf_a", store)
    const tool = findTool(buildMutateTools(), "wf_add_node")
    const result = (await tool.execute(
      { kind: "ai.prompt", position: { x: 100, y: 200 }, data: { label: "Hi" } },
      EMPTY_CTX
    )) as { ok: true; nodeId: string }
    expect(result.ok).toBe(true)
    const node = store.getState().nodes.find((n) => n.id === result.nodeId)
    expect(node?.data.label).toBe("Hi")
    expect(node?.data.authoredBy).toBe("ai")
  })

  it("wf_remove_node deletes a node + its incident edges", async () => {
    const store = createEditorStore(workflow("wf_a"))
    const a = store.getState().addNode("trigger.manual", { x: 0, y: 0 })
    const b = store.getState().addNode("ai.prompt", { x: 100, y: 0 })
    store.getState().connect({ source: a, target: b })
    registerEditorStore("wf_a", store)
    const tool = findTool(buildMutateTools(), "wf_remove_node")
    await tool.execute({ nodeId: b }, EMPTY_CTX)
    expect(store.getState().nodes.length).toBe(1)
    expect(store.getState().edges.length).toBe(0)
  })

  it("wf_connect_edge connects + applies optional label", async () => {
    const store = createEditorStore(workflow("wf_a"))
    const a = store.getState().addNode("trigger.manual", { x: 0, y: 0 })
    const b = store.getState().addNode("ai.prompt", { x: 100, y: 0 })
    registerEditorStore("wf_a", store)
    const tool = findTool(buildMutateTools(), "wf_connect_edge")
    const result = (await tool.execute({ source: a, target: b, label: "then" }, EMPTY_CTX)) as {
      ok: true
      edgeId: string
    }
    const edge = store.getState().edges.find((e) => e.id === result.edgeId)
    expect(edge).toBeDefined()
    expect((edge?.data as Record<string, unknown> | undefined)?.label).toBe("then")
  })

  it("wf_disconnect_edge removes by id", async () => {
    const store = createEditorStore(workflow("wf_a"))
    const a = store.getState().addNode("trigger.manual", { x: 0, y: 0 })
    const b = store.getState().addNode("ai.prompt", { x: 100, y: 0 })
    const edgeId = store.getState().connect({ source: a, target: b })
    registerEditorStore("wf_a", store)
    const tool = findTool(buildMutateTools(), "wf_disconnect_edge")
    await tool.execute({ edgeId }, EMPTY_CTX)
    expect(store.getState().edges.length).toBe(0)
  })

  it("wf_configure_node patches data and re-validates", async () => {
    const store = createEditorStore(workflow("wf_a"))
    const id = store.getState().addNode("ai.prompt", { x: 0, y: 0 })
    registerEditorStore("wf_a", store)
    const tool = findTool(buildMutateTools(), "wf_configure_node")
    await tool.execute({ nodeId: id, patch: { label: "Renamed" } }, EMPTY_CTX)
    const node = store.getState().nodes.find((n) => n.id === id)
    expect(node?.data.label).toBe("Renamed")
    expect(node?.data.authoredBy).toBe("ai")
  })

  it("wf_batch_apply runs a sequence atomically (per-op results)", async () => {
    const store = createEditorStore(workflow("wf_a"))
    registerEditorStore("wf_a", store)
    const tool = findTool(buildMutateTools(), "wf_batch_apply")
    const result = (await tool.execute(
      {
        ops: [
          { type: "add_node", kind: "trigger.manual", position: { x: 0, y: 0 } },
          { type: "add_node", kind: "ai.prompt", position: { x: 200, y: 0 } },
        ],
      },
      EMPTY_CTX
    )) as { ok: true; applied: Array<{ type: string; nodeId?: string }> }
    expect(result.applied.length).toBe(2)
    expect(store.getState().nodes.length).toBe(2)
  })

  it("wf_batch_apply stops on the first failure and reports failedAt", async () => {
    const store = createEditorStore(workflow("wf_a"))
    registerEditorStore("wf_a", store)
    const tool = findTool(buildMutateTools(), "wf_batch_apply")
    const result = (await tool.execute(
      {
        ops: [
          { type: "add_node", kind: "ai.prompt", position: { x: 0, y: 0 } },
          { type: "unknown-op", nodeId: "x" },
        ],
      },
      EMPTY_CTX
    )) as { ok: false; failedAt: number; error: { code: string } }
    expect(result.ok).toBe(false)
    expect(result.failedAt).toBe(1)
    expect(result.error.code).toBe("unknown-op")
    expect(store.getState().nodes.length).toBe(0)
  })

  it("wf_batch_apply rolls back every op when a connection is invalid", async () => {
    const store = createEditorStore(workflow("wf_a"))
    registerEditorStore("wf_a", store)
    const tool = findTool(buildMutateTools(), "wf_batch_apply")

    const result = (await tool.execute(
      {
        ops: [
          {
            type: "add_node",
            nodeId: "n_action",
            kind: "flow.set",
            position: { x: 0, y: 0 },
          },
          {
            type: "add_node",
            nodeId: "n_trigger",
            kind: "trigger.manual",
            position: { x: 200, y: 0 },
          },
          { type: "connect_edge", source: "n_action", target: "n_trigger" },
        ],
      },
      EMPTY_CTX
    )) as { ok: false; failedAt: number }

    expect(result.ok).toBe(false)
    expect(result.failedAt).toBe(2)
    expect(store.getState().nodes).toEqual([])
    expect(store.getState().edges).toEqual([])
  })

  it("single-op mutation tools reject missing node and edge ids", async () => {
    const store = createEditorStore(workflow("wf_a"))
    registerEditorStore("wf_a", store)
    const tools = buildMutateTools()

    await expect(
      findTool(tools, "wf_remove_node").execute({ nodeId: "missing" }, EMPTY_CTX)
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "node-not-found" },
    })
    await expect(
      findTool(tools, "wf_configure_node").execute({ nodeId: "missing", patch: {} }, EMPTY_CTX)
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "node-not-found" },
    })
    await expect(
      findTool(tools, "wf_disconnect_edge").execute({ edgeId: "missing" }, EMPTY_CTX)
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "edge-not-found" },
    })
  })
})

describe("layout tools", () => {
  it("wf_select_nodes pushes ids into the store selection", async () => {
    const store = createEditorStore(workflow("wf_a"))
    const id = store.getState().addNode("ai.prompt", { x: 0, y: 0 })
    registerEditorStore("wf_a", store)
    const tool = findTool(buildLayoutTools(), "wf_select_nodes")
    await tool.execute({ nodeIds: [id] }, EMPTY_CTX)
    expect(store.getState().selectedNodeIds).toEqual([id])
  })

  it("wf_focus_viewport with nodeId pulses the node and updates viewport", async () => {
    const store = createEditorStore(workflow("wf_a"))
    const id = store.getState().addNode("ai.prompt", { x: 0, y: 0 })
    registerEditorStore("wf_a", store)
    const tool = findTool(buildLayoutTools(), "wf_focus_viewport")
    const result = (await tool.execute({ nodeId: id }, EMPTY_CTX)) as { ok: true; focused: string }
    expect(result.focused).toBe(id)
    expect(store.getState().spotlightedNodeId).toBe(id)
  })

  it("wf_focus_viewport reports node-not-found gracefully", async () => {
    registerEditorStore("wf_a", createEditorStore(workflow("wf_a")))
    const tool = findTool(buildLayoutTools(), "wf_focus_viewport")
    const result = (await tool.execute({ nodeId: "nope" }, EMPTY_CTX)) as {
      ok: false
      error: { code: string }
    }
    expect(result.error.code).toBe("node-not-found")
  })

  it("wf_group_nodes wraps selected ids in an annotation.group", async () => {
    const store = createEditorStore(workflow("wf_a"))
    const a = store.getState().addNode("ai.prompt", { x: 0, y: 0 })
    const b = store.getState().addNode("ai.prompt", { x: 100, y: 0 })
    registerEditorStore("wf_a", store)
    const tool = findTool(buildLayoutTools(), "wf_group_nodes")
    const result = (await tool.execute({ nodeIds: [a, b] }, EMPTY_CTX)) as {
      ok: true
      groupId: string | null
    }
    expect(typeof result.groupId).toBe("string")
    const group = store.getState().nodes.find((n) => n.id === result.groupId)
    expect(group?.data.kind).toBe("annotation.group")
  })
})
