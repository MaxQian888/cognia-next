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

  it("preserves performanceTier across loadWorkflow (it is a user-level preference)", () => {
    const useStore = createEditorStore(emptyWorkflow())
    useStore.getState().setPerformanceTier("reduced")
    expect(useStore.getState().performanceTier).toBe("reduced")

    const fresh = emptyWorkflow()
    fresh.id = "wf_other"
    useStore.getState().loadWorkflow(fresh)

    expect(useStore.getState().performanceTier).toBe("reduced")
  })
})

describe("editor store — performance tier", () => {
  it("defaults to 'auto'", () => {
    const useStore = createEditorStore(emptyWorkflow())
    expect(useStore.getState().performanceTier).toBe("auto")
  })

  it("setPerformanceTier flips the value", () => {
    const useStore = createEditorStore(emptyWorkflow()) as ReturnType<typeof createEditorStore>
    useStore.getState().setPerformanceTier("balanced")
    expect(useStore.getState().performanceTier).toBe("balanced")
    useStore.getState().setPerformanceTier("high")
    expect(useStore.getState().performanceTier).toBe("high")
  })

  it("setPerformanceTier does not push entries onto the undo history", () => {
    const useStore = createEditorStore(emptyWorkflow())
    const before = useStore.temporal.getState().pastStates.length
    useStore.getState().setPerformanceTier("balanced")
    useStore.getState().setPerformanceTier("high")
    useStore.getState().setPerformanceTier("reduced")
    expect(useStore.temporal.getState().pastStates.length).toBe(before)
  })
})

describe("editor store — drag flag + snap-to-grid", () => {
  it("defaults isDraggingAny to false and snapToGrid to true", () => {
    const useStore = createEditorStore(emptyWorkflow())
    expect(useStore.getState().isDraggingAny).toBe(false)
    expect(useStore.getState().snapToGrid).toBe(true)
  })

  it("setIsDraggingAny / setSnapToGrid flip their values", () => {
    const useStore = createEditorStore(emptyWorkflow())
    useStore.getState().setIsDraggingAny(true)
    expect(useStore.getState().isDraggingAny).toBe(true)
    useStore.getState().setIsDraggingAny(false)
    expect(useStore.getState().isDraggingAny).toBe(false)

    useStore.getState().setSnapToGrid(false)
    expect(useStore.getState().snapToGrid).toBe(false)
  })

  it("toggling either flag does not push undo history entries", () => {
    const useStore = createEditorStore(emptyWorkflow())
    const before = useStore.temporal.getState().pastStates.length
    useStore.getState().setIsDraggingAny(true)
    useStore.getState().setSnapToGrid(false)
    useStore.getState().setIsDraggingAny(false)
    expect(useStore.temporal.getState().pastStates.length).toBe(before)
  })
})

describe("editor store — ephemeral hover/edit/spotlight slices", () => {
  it("setHoveredNode / setHoveredEdge skip no-op writes", () => {
    const useStore = createEditorStore(emptyWorkflow())
    useStore.getState().setHoveredNode("n_a")
    useStore.getState().setHoveredNode("n_a") // duplicate
    expect(useStore.getState().hoveredNodeId).toBe("n_a")
    useStore.getState().setHoveredNode(null)
    expect(useStore.getState().hoveredNodeId).toBeNull()

    useStore.getState().setHoveredEdge("e_1")
    expect(useStore.getState().hoveredEdgeId).toBe("e_1")
    useStore.getState().setHoveredEdge(null)
    expect(useStore.getState().hoveredEdgeId).toBeNull()
  })

  it("setEditingNodeIdInline / setEditingEdgeIdInline track string ids", () => {
    const useStore = createEditorStore(emptyWorkflow())
    useStore.getState().setEditingNodeIdInline("n_a")
    expect(useStore.getState().editingNodeIdInline).toBe("n_a")
    useStore.getState().setEditingEdgeIdInline("e_1")
    expect(useStore.getState().editingEdgeIdInline).toBe("e_1")
  })

  it("setPalettePrefillPosition stores then clears the position", () => {
    const useStore = createEditorStore(emptyWorkflow())
    useStore.getState().setPalettePrefillPosition({ x: 10, y: 20 })
    expect(useStore.getState().palettePrefillPosition).toEqual({ x: 10, y: 20 })
    useStore.getState().setPalettePrefillPosition(null)
    expect(useStore.getState().palettePrefillPosition).toBeNull()
  })

  it("pulseNode sets spotlightedNodeId immediately and clears after the timeout", () => {
    jest.useFakeTimers()
    try {
      const useStore = createEditorStore(emptyWorkflow())
      useStore.getState().pulseNode("n_a", 1500)
      expect(useStore.getState().spotlightedNodeId).toBe("n_a")
      jest.advanceTimersByTime(1500)
      expect(useStore.getState().spotlightedNodeId).toBeNull()
    } finally {
      jest.useRealTimers()
    }
  })

  it("pulseNode with durationMs = 0 sets and clears synchronously", () => {
    const useStore = createEditorStore(emptyWorkflow())
    useStore.getState().pulseNode("n_a", 0)
    expect(useStore.getState().spotlightedNodeId).toBeNull()
  })

  it("ephemeral slices do not pollute undo history", () => {
    const useStore = createEditorStore(emptyWorkflow())
    const before = useStore.temporal.getState().pastStates.length
    useStore.getState().setHoveredNode("n_a")
    useStore.getState().setHoveredEdge("e_1")
    useStore.getState().setEditingNodeIdInline("n_a")
    useStore.getState().setEditingEdgeIdInline("e_1")
    useStore.getState().setPalettePrefillPosition({ x: 0, y: 0 })
    useStore.getState().setSpotlightedNodeId("n_a")
    expect(useStore.temporal.getState().pastStates.length).toBe(before)
  })
})

describe("editor store — edge mutators", () => {
  it("updateEdgeData merges into the existing edge's data field (undoable)", () => {
    const useStore = createEditorStore(emptyWorkflow())
    const aId = useStore.getState().addNode("trigger.manual", { x: 0, y: 0 })
    const bId = useStore.getState().addNode("ai.prompt", { x: 200, y: 0 })
    const eId = useStore.getState().connect({ source: aId, target: bId })

    expect(useStore.getState().updateEdgeData(eId, { kind: "then" })).toBe(true)
    const edge = useStore.getState().edges.find((e) => e.id === eId)
    expect((edge?.data as Record<string, unknown> | undefined)?.kind).toBe("then")

    // Existing data is preserved on subsequent patches.
    useStore.getState().updateEdgeData(eId, { label: "ok" })
    const edge2 = useStore.getState().edges.find((e) => e.id === eId)
    expect((edge2?.data as Record<string, unknown> | undefined)?.kind).toBe("then")
    expect((edge2?.data as Record<string, unknown> | undefined)?.label).toBe("ok")
  })

  it("updateEdgeData returns false for unknown ids", () => {
    const useStore = createEditorStore(emptyWorkflow())
    expect(useStore.getState().updateEdgeData("missing", { kind: "then" })).toBe(false)
  })

  it("replaceEdge swaps source/target (powers Reverse Direction)", () => {
    const useStore = createEditorStore(emptyWorkflow())
    const aId = useStore.getState().addNode("trigger.manual", { x: 0, y: 0 })
    const bId = useStore.getState().addNode("ai.prompt", { x: 200, y: 0 })
    const eId = useStore.getState().connect({ source: aId, target: bId })

    expect(useStore.getState().replaceEdge(eId, { source: bId, target: aId })).toBe(true)
    const edge = useStore.getState().edges.find((e) => e.id === eId)
    expect(edge?.source).toBe(bId)
    expect(edge?.target).toBe(aId)
    // id remains stable.
    expect(edge?.id).toBe(eId)
  })

  it("removeEdges drops by id and updates the selection list", () => {
    const useStore = createEditorStore(emptyWorkflow())
    const aId = useStore.getState().addNode("trigger.manual", { x: 0, y: 0 })
    const bId = useStore.getState().addNode("ai.prompt", { x: 200, y: 0 })
    const eId = useStore.getState().connect({ source: aId, target: bId })
    useStore.getState().setSelectedEdges([eId])

    useStore.getState().removeEdges([eId])
    expect(useStore.getState().edges).toHaveLength(0)
    expect(useStore.getState().selectedEdgeIds).toEqual([])
  })

  it("removeEdges is a no-op for empty input", () => {
    const useStore = createEditorStore(emptyWorkflow())
    const before = useStore.temporal.getState().pastStates.length
    useStore.getState().removeEdges([])
    expect(useStore.temporal.getState().pastStates.length).toBe(before)
  })
})

describe("editor store — connectionState (drag silk)", () => {
  it("starts as null", () => {
    const useStore = createEditorStore(emptyWorkflow())
    expect(useStore.getState().connectionState).toBeNull()
  })

  it("beginConnection seeds source + null candidate/pointer", () => {
    const useStore = createEditorStore(emptyWorkflow())
    useStore.getState().beginConnection({ sourceId: "n_a", sourceHandle: "out" })
    expect(useStore.getState().connectionState).toEqual({
      sourceId: "n_a",
      sourceHandle: "out",
      candidate: null,
      pointer: null,
    })
  })

  it("updateConnectionPointer merges candidate + pointer", () => {
    const useStore = createEditorStore(emptyWorkflow())
    useStore.getState().beginConnection({ sourceId: "n_a", sourceHandle: null })
    useStore
      .getState()
      .updateConnectionPointer({ x: 10, y: 20 }, { nodeId: "n_b", handleId: null, distance: 14 })
    const cs = useStore.getState().connectionState!
    expect(cs.pointer).toEqual({ x: 10, y: 20 })
    expect(cs.candidate?.nodeId).toBe("n_b")
  })

  it("updateConnectionPointer skips no-op writes (same candidate + pointer)", () => {
    const useStore = createEditorStore(emptyWorkflow())
    useStore.getState().beginConnection({ sourceId: "n_a", sourceHandle: null })
    useStore
      .getState()
      .updateConnectionPointer({ x: 10, y: 20 }, { nodeId: "n_b", handleId: null, distance: 14 })
    const first = useStore.getState().connectionState
    useStore
      .getState()
      .updateConnectionPointer({ x: 10, y: 20 }, { nodeId: "n_b", handleId: null, distance: 14 })
    expect(useStore.getState().connectionState).toBe(first)
  })

  it("updateConnectionPointer is a no-op when no connection is in flight", () => {
    const useStore = createEditorStore(emptyWorkflow())
    useStore.getState().updateConnectionPointer({ x: 1, y: 2 }, null)
    expect(useStore.getState().connectionState).toBeNull()
  })

  it("endConnection clears the slice", () => {
    const useStore = createEditorStore(emptyWorkflow())
    useStore.getState().beginConnection({ sourceId: "n_a", sourceHandle: null })
    useStore.getState().endConnection()
    expect(useStore.getState().connectionState).toBeNull()
  })

  it("connection lifecycle does not push undo history entries", () => {
    const useStore = createEditorStore(emptyWorkflow())
    const before = useStore.temporal.getState().pastStates.length
    useStore.getState().beginConnection({ sourceId: "n_a", sourceHandle: null })
    useStore.getState().updateConnectionPointer({ x: 1, y: 1 }, null)
    useStore.getState().endConnection()
    expect(useStore.temporal.getState().pastStates.length).toBe(before)
  })
})

describe("editor store — requestedContextMenu signal", () => {
  it("requestContextMenu stores the target + anchor; clear returns it to null", () => {
    const useStore = createEditorStore(emptyWorkflow())
    expect(useStore.getState().requestedContextMenu).toBeNull()
    useStore.getState().requestContextMenu({ kind: "node", nodeId: "n_a" }, { x: 100, y: 200 })
    expect(useStore.getState().requestedContextMenu).toEqual({
      target: { kind: "node", nodeId: "n_a" },
      screenAnchor: { x: 100, y: 200 },
    })
    useStore.getState().clearRequestedContextMenu()
    expect(useStore.getState().requestedContextMenu).toBeNull()
  })

  it("requestContextMenu is ephemeral (no undo history entries)", () => {
    const useStore = createEditorStore(emptyWorkflow())
    const before = useStore.temporal.getState().pastStates.length
    useStore.getState().requestContextMenu({ kind: "edge", edgeId: "e_1" }, { x: 0, y: 0 })
    useStore.getState().clearRequestedContextMenu()
    expect(useStore.temporal.getState().pastStates.length).toBe(before)
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
