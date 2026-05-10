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

describe("editor store — productivity actions", () => {
  function seedTwoConnected() {
    const useStore = createEditorStore(emptyWorkflow())
    const aId = useStore.getState().addNode("trigger.manual", { x: 0, y: 0 })
    const bId = useStore.getState().addNode("ai.prompt", { x: 200, y: 0 })
    useStore.getState().connect({ source: aId, target: bId })
    useStore.getState().markSaved()
    return { useStore, aId, bId }
  }

  describe("duplicateNodes", () => {
    it("clones the selected nodes (offset 24/24) plus their internal edges", () => {
      const { useStore, aId, bId } = seedTwoConnected()
      const newIds = useStore.getState().duplicateNodes([aId, bId])
      expect(newIds).toHaveLength(2)
      expect(useStore.getState().nodes).toHaveLength(4)
      expect(useStore.getState().edges).toHaveLength(2)
      // Selection moves to the clones.
      expect(useStore.getState().selectedNodeIds).toEqual(newIds)
      // Cloned positions are offset by 24/24.
      const clonedA = useStore.getState().nodes.find((n) => n.id === newIds[0])
      expect(clonedA?.position).toEqual({ x: 24, y: 24 })
      // Dirty flag flipped.
      expect(useStore.getState().dirty).toBe(true)
    })

    it("returns [] and is a no-op when called with no ids", () => {
      const { useStore } = seedTwoConnected()
      const before = useStore.getState().nodes.length
      const out = useStore.getState().duplicateNodes([])
      expect(out).toEqual([])
      expect(useStore.getState().nodes).toHaveLength(before)
      expect(useStore.getState().dirty).toBe(false)
    })

    it("drops dangling edges when only some endpoints are selected", () => {
      const { useStore, aId, bId } = seedTwoConnected()
      const newIds = useStore.getState().duplicateNodes([aId])
      expect(newIds).toHaveLength(1)
      // The original a→b edge has only one endpoint selected → no clone.
      // Total edges still 1 (the original).
      expect(useStore.getState().edges).toHaveLength(1)
      expect(useStore.getState().nodes).toHaveLength(3)
      // bId is still around.
      expect(useStore.getState().nodes.find((n) => n.id === bId)).toBeDefined()
    })
  })

  describe("pasteFromEnvelope", () => {
    it("inserts envelope nodes/edges with fresh ids and selects them", () => {
      const useStore = createEditorStore(emptyWorkflow())
      const envelope = {
        format: "cognia.workflow.clipboard.v1" as const,
        version: 1 as const,
        nodes: [
          {
            id: "n_old_a",
            type: "workflowNode" as const,
            position: { x: 50, y: 50 },
            data: {
              label: "Pasted",
              params: {},
              kind: "trigger.manual" as const,
              typeVersion: 1,
            },
          },
        ],
        edges: [],
      }
      const newIds = useStore.getState().pasteFromEnvelope(envelope)
      expect(newIds).toHaveLength(1)
      expect(useStore.getState().nodes).toHaveLength(1)
      expect(useStore.getState().nodes[0].id).not.toBe("n_old_a")
      // Position offset = 24/24
      expect(useStore.getState().nodes[0].position).toEqual({ x: 74, y: 74 })
      expect(useStore.getState().selectedNodeIds).toEqual(newIds)
    })

    it("returns [] for an empty envelope", () => {
      const useStore = createEditorStore(emptyWorkflow())
      const out = useStore.getState().pasteFromEnvelope({
        format: "cognia.workflow.clipboard.v1",
        version: 1,
        nodes: [],
        edges: [],
      })
      expect(out).toEqual([])
      expect(useStore.getState().nodes).toEqual([])
    })
  })

  describe("groupSelected", () => {
    it("inserts an annotation.group sized to the selection bounding box", () => {
      const { useStore, aId, bId } = seedTwoConnected()
      const groupId = useStore.getState().groupSelected([aId, bId])
      expect(groupId).not.toBeNull()
      const group = useStore.getState().nodes.find((n) => n.id === groupId!)
      expect(group?.data.kind).toBe("annotation.group")
      // Group goes to the FRONT of the array so it paints under members.
      expect(useStore.getState().nodes[0].id).toBe(groupId)
      // The new group is the only selected node.
      expect(useStore.getState().selectedNodeIds).toEqual([groupId])
      // Sized large enough to encompass both default 240×80 nodes (a@0,0 and
      // b@200,0) plus padding on every side.
      const params = group!.data.params as { width?: number; height?: number }
      expect(params.width ?? 0).toBeGreaterThan(440)
      expect(params.height ?? 0).toBeGreaterThan(80)
    })

    it("returns null on an empty selection", () => {
      const useStore = createEditorStore(emptyWorkflow())
      expect(useStore.getState().groupSelected([])).toBeNull()
      expect(useStore.getState().nodes).toEqual([])
    })

    it("returns null when the ids don't match any nodes", () => {
      const { useStore } = seedTwoConnected()
      expect(useStore.getState().groupSelected(["does-not-exist"])).toBeNull()
    })
  })

  describe("selectAll", () => {
    it("selects every node and edge", () => {
      const { useStore, aId, bId } = seedTwoConnected()
      useStore.getState().selectAll()
      expect(useStore.getState().selectedNodeIds.sort()).toEqual([aId, bId].sort())
      expect(useStore.getState().selectedEdgeIds).toHaveLength(1)
    })
  })
})

describe("editor store — validation", () => {
  it("revalidateNode writes a result and clears it once errors are fixed", () => {
    const useStore = createEditorStore(emptyWorkflow())
    const id = useStore.getState().addNode("trigger.cron", { x: 0, y: 0 })
    // Invalid (empty cron) → stored
    let result = useStore.getState().revalidateNode(id)
    expect(result.hasErrors).toBe(true)
    expect(useStore.getState().validationByStepId[id]).toBeDefined()

    // Fix the params → revalidation removes the entry
    useStore.getState().updateNodeData(id, { params: { cron: "0 9 * * 1-5" } })
    result = useStore.getState().revalidateNode(id)
    expect(result.hasErrors).toBe(false)
    expect(useStore.getState().validationByStepId[id]).toBeUndefined()
  })

  it("revalidateNode is a no-op when result is unchanged", () => {
    const useStore = createEditorStore(emptyWorkflow())
    const id = useStore.getState().addNode("trigger.cron", { x: 0, y: 0 })
    useStore.getState().revalidateNode(id)
    const ref1 = useStore.getState().validationByStepId
    useStore.getState().revalidateNode(id)
    const ref2 = useStore.getState().validationByStepId
    expect(ref1).toBe(ref2)
  })

  it("revalidateAll covers every node and prunes passing ones", () => {
    const useStore = createEditorStore(emptyWorkflow())
    const a = useStore.getState().addNode("trigger.manual", { x: 0, y: 0 })
    const b = useStore.getState().addNode("trigger.cron", { x: 200, y: 0 })
    const errs = useStore.getState().revalidateAll()
    expect(Object.keys(errs)).toEqual([b])
    expect(errs[a]).toBeUndefined()
  })

  it("revalidateNode returns a clean shape when the id doesn't match", () => {
    const useStore = createEditorStore(emptyWorkflow())
    const r = useStore.getState().revalidateNode("does-not-exist")
    expect(r.hasErrors).toBe(false)
    expect(r.fields).toEqual({})
  })
})
