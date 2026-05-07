/**
 * @jest-environment jsdom
 */
import { createEditorStore } from "./store"
import type { VisualWorkflow } from "@/types/workflow/visual"

function emptyWorkflow(): VisualWorkflow {
  return {
    id: "wf_test",
    schemaVersion: 1,
    name: "Empty",
    createdAt: 1,
    updatedAt: 1,
    nodes: [],
    edges: [],
    settings: {
      errorPolicy: "stop",
      timeoutMs: 60_000,
      concurrency: 1,
      retryDefaults: { attempts: 3, backoff: "exponential", baseMs: 1000 },
    },
    viewport: { x: 0, y: 0, zoom: 1 },
  }
}

describe("editor store — graph mutations", () => {
  it("adds, connects, updates, and removes nodes", () => {
    const useStore = createEditorStore(emptyWorkflow())
    const aId = useStore.getState().addNode("trigger.manual", { x: 0, y: 0 })
    const bId = useStore.getState().addNode("ai.prompt", { x: 200, y: 0 })
    expect(useStore.getState().nodes).toHaveLength(2)

    const eId = useStore.getState().connect({ source: aId, target: bId })
    expect(useStore.getState().edges).toHaveLength(1)
    expect(useStore.getState().edges[0].id).toBe(eId)

    useStore.getState().updateNodeData(aId, { label: "Renamed" })
    expect(useStore.getState().nodes.find((n) => n.id === aId)?.data.label).toBe("Renamed")

    useStore.getState().removeNodes([aId])
    expect(useStore.getState().nodes).toHaveLength(1)
    expect(useStore.getState().edges).toHaveLength(0) // edge removed because endpoint is gone
  })

  it("tracks the dirty flag", () => {
    const useStore = createEditorStore(emptyWorkflow())
    expect(useStore.getState().dirty).toBe(false)
    useStore.getState().addNode("trigger.manual", { x: 0, y: 0 })
    expect(useStore.getState().dirty).toBe(true)
    useStore.getState().markSaved()
    expect(useStore.getState().dirty).toBe(false)
  })

  it("supplies a sensible label by default", () => {
    const useStore = createEditorStore(emptyWorkflow())
    const id = useStore.getState().addNode("flow.branch", { x: 0, y: 0 })
    expect(useStore.getState().nodes.find((n) => n.id === id)?.data.label).toBe("If / else")
    const id2 = useStore.getState().addNode("data.code", { x: 0, y: 0 })
    // Unknown kinds fall back to the kind string.
    expect(useStore.getState().nodes.find((n) => n.id === id2)?.data.label).toBe("data.code")
  })

  it("respects label/notes/params overrides at addNode time", () => {
    const useStore = createEditorStore(emptyWorkflow())
    const id = useStore
      .getState()
      .addNode(
        "ai.prompt",
        { x: 0, y: 0 },
        { label: "Custom", params: { temperature: 0.2 }, notes: "hint" }
      )
    const node = useStore.getState().nodes.find((n) => n.id === id)!
    expect(node.data.label).toBe("Custom")
    expect((node.data.params as Record<string, unknown>).temperature).toBe(0.2)
    expect(node.data.notes).toBe("hint")
  })
})

describe("editor store — selection", () => {
  it("tracks node and edge selection separately", () => {
    const useStore = createEditorStore(emptyWorkflow())
    useStore.getState().setSelectedNodes(["a", "b"])
    useStore.getState().setSelectedEdges(["e1"])
    expect(useStore.getState().selectedNodeIds).toEqual(["a", "b"])
    expect(useStore.getState().selectedEdgeIds).toEqual(["e1"])
    useStore.getState().clearSelection()
    expect(useStore.getState().selectedNodeIds).toEqual([])
    expect(useStore.getState().selectedEdgeIds).toEqual([])
  })
})

describe("editor store — envelope mutators", () => {
  it("renames the workflow without touching nodes", () => {
    const useStore = createEditorStore(emptyWorkflow())
    useStore.getState().addNode("trigger.manual", { x: 0, y: 0 })
    useStore.getState().setName("Renamed workflow")
    useStore.getState().setDescription("A description")
    expect(useStore.getState().baseWorkflow.name).toBe("Renamed workflow")
    expect(useStore.getState().baseWorkflow.description).toBe("A description")
    expect(useStore.getState().nodes).toHaveLength(1)
  })
})

describe("editor store — toWorkflow round-trip", () => {
  it("serializes back into a VisualWorkflow", () => {
    const useStore = createEditorStore(emptyWorkflow())
    const a = useStore.getState().addNode("trigger.manual", { x: 0, y: 0 })
    const b = useStore.getState().addNode("ai.prompt", { x: 200, y: 0 })
    useStore.getState().connect({ source: a, target: b })

    const wf = useStore.getState().toWorkflow()
    expect(wf.nodes).toHaveLength(2)
    expect(wf.nodes[0].type).toBe("trigger.manual")
    expect(wf.edges).toHaveLength(1)
    expect(wf.edges[0].source).toBe(a)
    expect(wf.edges[0].target).toBe(b)
  })
})

describe("editor store — loadWorkflow", () => {
  it("replaces all state and clears selection + dirty", () => {
    const useStore = createEditorStore(emptyWorkflow())
    useStore.getState().addNode("trigger.manual", { x: 0, y: 0 })
    useStore.getState().setSelectedNodes(["x"])
    expect(useStore.getState().dirty).toBe(true)

    const fresh = emptyWorkflow()
    fresh.id = "wf_other"
    fresh.name = "Other"
    fresh.nodes = [
      {
        id: "n_other",
        type: "ai.prompt",
        typeVersion: 1,
        position: { x: 100, y: 100 },
        data: { label: "Other", params: {} },
      },
    ]
    useStore.getState().loadWorkflow(fresh)

    expect(useStore.getState().baseWorkflow.id).toBe("wf_other")
    expect(useStore.getState().nodes).toHaveLength(1)
    expect(useStore.getState().nodes[0].id).toBe("n_other")
    expect(useStore.getState().selectedNodeIds).toEqual([])
    expect(useStore.getState().dirty).toBe(false)
  })
})
