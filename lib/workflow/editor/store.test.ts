/**
 * @jest-environment jsdom
 */
import { createEditorStore, EDITOR_HISTORY_LIMIT } from "./store"
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

  it("authors new branch/switch/ai.prompt nodes at typeVersion 2, others at 1", () => {
    const useStore = createEditorStore(emptyWorkflow())
    const branchId = useStore.getState().addNode("flow.branch", { x: 0, y: 0 })
    const switchId = useStore.getState().addNode("flow.switch", { x: 0, y: 0 })
    // ai.prompt v2 = routed mode + PII gate + streaming (explicit mode stays
    // wire-compatible with v1).
    const aiId = useStore.getState().addNode("ai.prompt", { x: 0, y: 0 })
    const setId = useStore.getState().addNode("flow.set", { x: 0, y: 0 })
    const byId = (id: string) => useStore.getState().nodes.find((n) => n.id === id)!
    expect(byId(branchId).data.typeVersion).toBe(2)
    expect(byId(switchId).data.typeVersion).toBe(2)
    expect(byId(aiId).data.typeVersion).toBe(2)
    expect(byId(setId).data.typeVersion).toBe(1)
  })

  it("setNodeParent re-parents with relative coordinates and clears on null", () => {
    const useStore = createEditorStore(emptyWorkflow())
    const loopId = useStore.getState().addNode("flow.loop", { x: 100, y: 100 })
    const childId = useStore.getState().addNode("flow.set", { x: 150, y: 160 })

    useStore.getState().setNodeParent(childId, loopId)
    let child = useStore.getState().nodes.find((n) => n.id === childId)!
    expect(child.parentId).toBe(loopId)
    expect(child.extent).toBe("parent")
    // Absolute (150,160) inside a parent at (100,100) → relative (50,60).
    expect(child.position).toEqual({ x: 50, y: 60 })

    useStore.getState().setNodeParent(childId, null)
    child = useStore.getState().nodes.find((n) => n.id === childId)!
    expect(child.parentId).toBeUndefined()
    expect(child.extent).toBeUndefined()
    // Back to absolute coordinates.
    expect(child.position).toEqual({ x: 150, y: 160 })
  })

  it("setNodeParent refuses self-parenting and parenting into a non-container", () => {
    const useStore = createEditorStore(emptyWorkflow())
    const loopId = useStore.getState().addNode("flow.loop", { x: 0, y: 0 })
    const aiId = useStore.getState().addNode("ai.prompt", { x: 10, y: 10 })
    useStore.getState().setNodeParent(loopId, loopId)
    expect(useStore.getState().nodes.find((n) => n.id === loopId)?.parentId).toBeUndefined()
    useStore.getState().setNodeParent(loopId, aiId)
    expect(useStore.getState().nodes.find((n) => n.id === loopId)?.parentId).toBeUndefined()
  })

  it("removing a loop container cascades to its children", () => {
    const useStore = createEditorStore(emptyWorkflow())
    const loopId = useStore.getState().addNode("flow.loop", { x: 0, y: 0 })
    const childId = useStore.getState().addNode("flow.set", { x: 10, y: 10 })
    useStore.getState().setNodeParent(childId, loopId)
    const outsideId = useStore.getState().addNode("ai.prompt", { x: 500, y: 0 })

    useStore.getState().removeNodes([loopId])
    const ids = useStore.getState().nodes.map((n) => n.id)
    expect(ids).not.toContain(loopId)
    expect(ids).not.toContain(childId)
    expect(ids).toContain(outsideId)
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

describe("editor store — updateNodeDataBatch", () => {
  it("patches every selected node and is one undo entry", () => {
    const useStore = createEditorStore(emptyWorkflow())
    const a = useStore.getState().addNode("trigger.manual", { x: 0, y: 0 })
    const b = useStore.getState().addNode("ai.prompt", { x: 100, y: 0 })
    const c = useStore.getState().addNode("data.code", { x: 200, y: 0 })

    const before = useStore.temporal.getState().pastStates.length
    useStore.getState().updateNodeDataBatch([a, b], { disabled: true, notes: "off" })

    const byId = (id: string) => useStore.getState().nodes.find((n) => n.id === id)!
    expect(byId(a).data.disabled).toBe(true)
    expect(byId(b).data.disabled).toBe(true)
    expect(byId(a).data.notes).toBe("off")
    expect(byId(c).data.disabled).toBeUndefined() // untouched

    // single set() → exactly one new undo entry for the whole batch
    expect(useStore.temporal.getState().pastStates.length).toBe(before + 1)
    useStore.temporal.getState().undo()
    expect(byId(a).data.disabled).toBeUndefined()
    expect(byId(b).data.disabled).toBeUndefined()
  })

  it("is a no-op for an empty id list", () => {
    const useStore = createEditorStore(emptyWorkflow())
    useStore.getState().addNode("trigger.manual", { x: 0, y: 0 })
    const before = useStore.temporal.getState().pastStates.length
    useStore.getState().updateNodeDataBatch([], { disabled: true })
    expect(useStore.temporal.getState().pastStates.length).toBe(before)
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

  it("setSettings shallow-merges run settings and marks dirty", () => {
    const useStore = createEditorStore(emptyWorkflow())
    useStore.getState().setSettings({ errorPolicy: "branch", concurrency: 4 })
    const s = useStore.getState().baseWorkflow.settings
    expect(s.errorPolicy).toBe("branch")
    expect(s.concurrency).toBe(4)
    // Unrelated settings preserved.
    expect(s.timeoutMs).toBeGreaterThan(0)
    expect(useStore.getState().dirty).toBe(true)
  })

  it("setVariables replaces the variables map and marks dirty", () => {
    const useStore = createEditorStore(emptyWorkflow())
    useStore.getState().setVariables({ API_BASE: "https://x" })
    expect(useStore.getState().baseWorkflow.variables).toEqual({ API_BASE: "https://x" })
    expect(useStore.getState().dirty).toBe(true)
  })

  it("setCredentials replaces the credential refs map", () => {
    const useStore = createEditorStore(emptyWorkflow())
    useStore.getState().setCredentials({ a: { id: "a", name: "A" } })
    expect(useStore.getState().baseWorkflow.credentials).toEqual({ a: { id: "a", name: "A" } })
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

describe("editor store — drag history coalescing", () => {
  function withOneNode() {
    const useStore = createEditorStore(emptyWorkflow())
    useStore.getState().addNode("trigger.manual", { x: 0, y: 0 })
    return useStore
  }

  /** Simulate one drag frame: replace only the first node's position. */
  function moveFirstNode(useStore: ReturnType<typeof createEditorStore>, x: number, y: number) {
    const next = useStore
      .getState()
      .nodes.map((n, i) => (i === 0 ? { ...n, position: { x, y } } : n))
    useStore.getState().setNodes(next)
  }

  it("coalesces a multi-frame drag into a single undo entry", () => {
    const useStore = withOneNode()
    const before = useStore.temporal.getState().pastStates.length

    useStore.getState().beginDragHistory()
    moveFirstNode(useStore, 10, 0)
    moveFirstNode(useStore, 20, 0)
    moveFirstNode(useStore, 30, 0)
    // Paused: not one of the intermediate frames is recorded.
    expect(useStore.temporal.getState().pastStates.length).toBe(before)

    useStore.getState().commitDragHistory()
    // Exactly one entry for the whole drag; redo stack cleared.
    expect(useStore.temporal.getState().pastStates.length).toBe(before + 1)
    expect(useStore.temporal.getState().futureStates).toHaveLength(0)
    expect(useStore.getState().nodes[0].position).toEqual({ x: 30, y: 0 })
  })

  it("undo after a coalesced drag restores the pre-drag position in one step", () => {
    const useStore = withOneNode()
    useStore.getState().beginDragHistory()
    moveFirstNode(useStore, 99, 99)
    useStore.getState().commitDragHistory()

    useStore.temporal.getState().undo()
    expect(useStore.getState().nodes[0].position).toEqual({ x: 0, y: 0 })
  })

  it("records nothing for a no-op drag (no movement between begin and commit)", () => {
    const useStore = withOneNode()
    const before = useStore.temporal.getState().pastStates.length
    useStore.getState().beginDragHistory()
    useStore.getState().commitDragHistory()
    expect(useStore.temporal.getState().pastStates.length).toBe(before)
  })

  it("is idempotent across overlapping begin calls (node + selection drag)", () => {
    const useStore = withOneNode()
    const before = useStore.temporal.getState().pastStates.length
    useStore.getState().beginDragHistory()
    useStore.getState().beginDragHistory() // second begin must not re-snapshot
    moveFirstNode(useStore, 5, 5)
    useStore.getState().commitDragHistory()
    expect(useStore.temporal.getState().pastStates.length).toBe(before + 1)
  })

  it("trims a coalesced drag entry to EDITOR_HISTORY_LIMIT", () => {
    const useStore = withOneNode()
    // Seed the history at the cap so the commit must trim one off the front.
    const filler = Array.from({ length: EDITOR_HISTORY_LIMIT }, () => ({ nodes: [], edges: [] }))
    useStore.temporal.setState({ pastStates: filler, futureStates: [] })
    expect(useStore.temporal.getState().pastStates).toHaveLength(EDITOR_HISTORY_LIMIT)

    useStore.getState().beginDragHistory()
    moveFirstNode(useStore, 7, 7)
    useStore.getState().commitDragHistory()

    expect(useStore.temporal.getState().pastStates).toHaveLength(EDITOR_HISTORY_LIMIT)
    // The newest (last) entry is the pre-drag snapshot we just pushed.
    const newest = useStore.temporal.getState().pastStates.at(-1)
    expect(newest?.nodes?.[0]?.position).toEqual({ x: 0, y: 0 })
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

describe("editor store — applyProposalOps", () => {
  it("returns applied=0 and is a no-op for an empty batch", () => {
    const useStore = createEditorStore(emptyWorkflow())
    const result = useStore.getState().applyProposalOps([])
    expect(result.applied).toBe(0)
    expect(useStore.getState().nodes).toHaveLength(0)
    expect(useStore.getState().dirty).toBe(false)
  })

  it("adds nodes + connects them in one batch and stamps authoredBy: 'ai'", () => {
    const useStore = createEditorStore(emptyWorkflow())
    const result = useStore.getState().applyProposalOps([
      {
        type: "add_node",
        nodeId: "n_a",
        kind: "trigger.manual",
        position: { x: 0, y: 0 },
      },
      {
        type: "add_node",
        nodeId: "n_b",
        kind: "ai.prompt",
        position: { x: 200, y: 0 },
        data: { params: { userPrompt: "hello" } },
      },
      {
        type: "connect_edge",
        edgeId: "e_ab",
        source: "n_a",
        target: "n_b",
      },
    ])
    expect(result.applied).toBe(3)
    expect(result.firstError).toBeUndefined()
    const state = useStore.getState()
    expect(state.nodes).toHaveLength(2)
    expect(state.edges).toHaveLength(1)
    expect(state.dirty).toBe(true)
    for (const n of state.nodes) {
      expect(n.data.authoredBy).toBe("ai")
    }
  })

  it("the entire batch is a SINGLE zundo entry — one undo reverses it", () => {
    const useStore = createEditorStore(emptyWorkflow())
    useStore.getState().applyProposalOps([
      { type: "add_node", nodeId: "n_a", kind: "trigger.manual", position: { x: 0, y: 0 } },
      {
        type: "add_node",
        nodeId: "n_b",
        kind: "ai.prompt",
        position: { x: 200, y: 0 },
        data: { params: { userPrompt: "hi" } },
      },
      { type: "connect_edge", edgeId: "e_ab", source: "n_a", target: "n_b" },
    ])
    expect(useStore.getState().nodes).toHaveLength(2)
    expect(useStore.getState().edges).toHaveLength(1)
    useStore.temporal.getState().undo()
    expect(useStore.getState().nodes).toHaveLength(0)
    expect(useStore.getState().edges).toHaveLength(0)
  })

  it("supports configure_node and runs validation on touched nodes", () => {
    const useStore = createEditorStore(emptyWorkflow())
    // Add a cron trigger without a cron expression — should produce a validation error.
    useStore
      .getState()
      .applyProposalOps([
        { type: "add_node", nodeId: "n_cron", kind: "trigger.cron", position: { x: 0, y: 0 } },
      ])
    expect(useStore.getState().validationByStepId["n_cron"]).toBeDefined()
    // Configure it to a valid value — validation should clear.
    useStore.getState().applyProposalOps([
      {
        type: "configure_node",
        nodeId: "n_cron",
        patch: { params: { cron: "0 9 * * 1-5" } },
      },
    ])
    expect(useStore.getState().validationByStepId["n_cron"]).toBeUndefined()
  })

  it("rejects connect_edge with a dangling source and surfaces firstError", () => {
    const useStore = createEditorStore(emptyWorkflow())
    const result = useStore.getState().applyProposalOps([
      {
        type: "connect_edge",
        edgeId: "e_dangling",
        source: "n_nonexistent",
        target: "n_also_nonexistent",
      },
    ])
    expect(result.applied).toBe(0)
    expect(result.firstError).toMatch(/n_nonexistent.*does not exist/)
    expect(useStore.getState().edges).toHaveLength(0)
  })

  it("rejects duplicate node id but continues with subsequent ops", () => {
    const useStore = createEditorStore(emptyWorkflow())
    useStore
      .getState()
      .applyProposalOps([
        { type: "add_node", nodeId: "n_a", kind: "trigger.manual", position: { x: 0, y: 0 } },
      ])
    const result = useStore.getState().applyProposalOps([
      // Duplicate id — should fail.
      { type: "add_node", nodeId: "n_a", kind: "ai.prompt", position: { x: 200, y: 0 } },
      // Valid follow-up — should still apply.
      { type: "add_node", nodeId: "n_b", kind: "ai.prompt", position: { x: 400, y: 0 } },
    ])
    expect(result.applied).toBe(1)
    expect(result.firstError).toMatch(/already exists/)
    expect(
      useStore
        .getState()
        .nodes.map((n) => n.id)
        .sort()
    ).toEqual(["n_a", "n_b"])
  })

  it("removing a node also drops incident edges + prunes its selection + validation", () => {
    const useStore = createEditorStore(emptyWorkflow())
    useStore.getState().applyProposalOps([
      { type: "add_node", nodeId: "n_a", kind: "trigger.manual", position: { x: 0, y: 0 } },
      { type: "add_node", nodeId: "n_b", kind: "trigger.cron", position: { x: 200, y: 0 } },
      { type: "connect_edge", edgeId: "e_ab", source: "n_a", target: "n_b" },
    ])
    useStore.getState().setSelectedNodes(["n_a", "n_b"])
    expect(useStore.getState().validationByStepId["n_b"]).toBeDefined()

    useStore.getState().applyProposalOps([{ type: "remove_node", nodeId: "n_b" }])
    const state = useStore.getState()
    expect(state.nodes.map((n) => n.id)).toEqual(["n_a"])
    expect(state.edges).toHaveLength(0)
    expect(state.selectedNodeIds).toEqual(["n_a"])
    expect(state.validationByStepId["n_b"]).toBeUndefined()
  })

  it("disconnect_edge removes the edge without touching nodes", () => {
    const useStore = createEditorStore(emptyWorkflow())
    useStore.getState().applyProposalOps([
      { type: "add_node", nodeId: "n_a", kind: "trigger.manual", position: { x: 0, y: 0 } },
      {
        type: "add_node",
        nodeId: "n_b",
        kind: "ai.prompt",
        position: { x: 200, y: 0 },
        data: { params: { userPrompt: "hi" } },
      },
      { type: "connect_edge", edgeId: "e_ab", source: "n_a", target: "n_b" },
    ])
    useStore.getState().applyProposalOps([{ type: "disconnect_edge", edgeId: "e_ab" }])
    expect(useStore.getState().nodes).toHaveLength(2)
    expect(useStore.getState().edges).toHaveLength(0)
  })
})

describe("editor store — pin data", () => {
  it("pins a node's output onto baseWorkflow.pinData and marks dirty", () => {
    const useStore = createEditorStore(emptyWorkflow())
    useStore.getState().pinNodeData("n_a", { value: 1 })
    expect(useStore.getState().baseWorkflow.pinData).toEqual({ n_a: { value: 1 } })
    expect(useStore.getState().dirty).toBe(true)
  })

  it("merges multiple pins and the converter round-trips them via toWorkflow", () => {
    const useStore = createEditorStore(emptyWorkflow())
    useStore.getState().pinNodeData("n_a", { a: 1 })
    useStore.getState().pinNodeData("n_b", { b: 2 })
    expect(useStore.getState().toWorkflow().pinData).toEqual({ n_a: { a: 1 }, n_b: { b: 2 } })
  })

  it("unpins a node, and is a no-op (no dirty) when the pin is absent", () => {
    const useStore = createEditorStore(emptyWorkflow())
    useStore.getState().pinNodeData("n_a", { a: 1 })
    useStore.getState().markSaved()
    useStore.getState().unpinNodeData("n_a")
    expect(useStore.getState().baseWorkflow.pinData).toEqual({})
    expect(useStore.getState().dirty).toBe(true)

    useStore.getState().markSaved()
    useStore.getState().unpinNodeData("n_missing")
    expect(useStore.getState().dirty).toBe(false)
  })
})

describe("editor store — run-single-step signal", () => {
  it("sets and clears requestedRunSingleStepId without polluting undo history", () => {
    const useStore = createEditorStore(emptyWorkflow())
    const before = useStore.temporal.getState().pastStates.length
    expect(useStore.getState().requestedRunSingleStepId).toBeNull()
    useStore.getState().requestRunSingleStep("n_c")
    expect(useStore.getState().requestedRunSingleStepId).toBe("n_c")
    useStore.getState().clearRequestedRunSingleStep()
    expect(useStore.getState().requestedRunSingleStepId).toBeNull()
    expect(useStore.temporal.getState().pastStates.length).toBe(before)
  })
})

describe("editor store — diagnostics", () => {
  it("seeds diagnostics on creation and recomputes on demand", () => {
    const useStore = createEditorStore(emptyWorkflow())
    // Empty workflow: no trigger → a missingTrigger warning is expected.
    expect(useStore.getState().diagnostics.warningCount).toBeGreaterThanOrEqual(1)

    const aId = useStore.getState().addNode("trigger.manual", { x: 0, y: 0 })
    const bId = useStore.getState().addNode("ai.prompt", { x: 200, y: 0 })
    useStore.getState().connect({ source: aId, target: bId })
    // Reference an unknown node from b's params.
    useStore.getState().updateNodeData(bId, {
      params: { userPrompt: "{{ $node['ghost'].out.x }}" },
    })

    const result = useStore.getState().recomputeDiagnostics()
    expect(result.diagnostics.some((d) => d.code === "exprUnknownNode")).toBe(true)
    expect(useStore.getState().diagnostics).toBe(result)
  })

  it("returns the same result identity when nothing changed (signature short-circuit)", () => {
    const useStore = createEditorStore(emptyWorkflow())
    const first = useStore.getState().recomputeDiagnostics()
    const second = useStore.getState().recomputeDiagnostics()
    expect(second).toBe(first)
  })

  it("debounces recompute via scheduleDiagnostics after a graph mutation", () => {
    jest.useFakeTimers()
    try {
      const useStore = createEditorStore(emptyWorkflow())
      const before = useStore.getState().diagnostics
      // Adding a trigger should clear the missingTrigger warning once the
      // debounced driver fires.
      useStore.getState().addNode("trigger.manual", { x: 0, y: 0 })
      // Not yet recomputed (still within debounce window).
      expect(useStore.getState().diagnostics).toBe(before)
      jest.advanceTimersByTime(350)
      expect(useStore.getState().diagnostics).not.toBe(before)
      expect(useStore.getState().diagnostics.warningCount).toBe(0)
    } finally {
      jest.useRealTimers()
    }
  })
})

describe("editor store — problems-panel signal", () => {
  it("sets and clears the requestedProblemsPanel signal", () => {
    const useStore = createEditorStore(emptyWorkflow())
    expect(useStore.getState().requestedProblemsPanel).toBe(false)
    useStore.getState().requestProblemsPanel()
    expect(useStore.getState().requestedProblemsPanel).toBe(true)
    useStore.getState().clearRequestedProblemsPanel()
    expect(useStore.getState().requestedProblemsPanel).toBe(false)
  })
})

describe("editor store — insertNodeOnEdge", () => {
  it("splits an edge into source → new → target in one undo entry", () => {
    const useStore = createEditorStore(emptyWorkflow())
    const a = useStore.getState().addNode("trigger.manual", { x: 0, y: 0 })
    const b = useStore.getState().addNode("ai.prompt", { x: 400, y: 0 })
    const e = useStore.getState().connect({ source: a, target: b })
    expect(useStore.getState().edges).toHaveLength(1)

    const mid = useStore.getState().insertNodeOnEdge(e, "ai.prompt", { x: 200, y: 0 })
    expect(mid).toBeTruthy()
    const s = useStore.getState()
    expect(s.nodes).toHaveLength(3)
    // Original edge gone; two replacements wiring a → mid → b.
    expect(s.edges.find((x) => x.id === e)).toBeUndefined()
    expect(s.edges).toHaveLength(2)
    expect(s.edges.some((x) => x.source === a && x.target === mid)).toBe(true)
    expect(s.edges.some((x) => x.source === mid && x.target === b)).toBe(true)

    // Single undo restores the pre-insert graph.
    useStore.temporal.getState().undo()
    expect(useStore.getState().nodes).toHaveLength(2)
    expect(useStore.getState().edges).toHaveLength(1)
  })

  it("preserves the source handle of a branch edge", () => {
    const useStore = createEditorStore(emptyWorkflow())
    const br = useStore.getState().addNode("flow.branch", { x: 0, y: 0 }) // typeVersion 2
    const b = useStore.getState().addNode("ai.prompt", { x: 400, y: 0 })
    const e = useStore.getState().connect({ source: br, target: b, sourceHandle: "true" })
    const mid = useStore.getState().insertNodeOnEdge(e, "ai.prompt", { x: 200, y: 0 })
    const upstream = useStore.getState().edges.find((x) => x.source === br && x.target === mid)
    expect(upstream?.sourceHandle).toBe("true")
  })

  it("returns null for an unknown edge id", () => {
    const useStore = createEditorStore(emptyWorkflow())
    expect(useStore.getState().insertNodeOnEdge("nope", "ai.prompt", { x: 0, y: 0 })).toBeNull()
  })
})

describe("editor store — addNodeConnected (C2/C3)", () => {
  it("creates a node and wires source → it in one undo entry", () => {
    const useStore = createEditorStore(emptyWorkflow())
    const a = useStore.getState().addNode("trigger.manual", { x: 0, y: 0 })
    const id = useStore.getState().addNodeConnected(
      "ai.prompt",
      { x: 320, y: 0 },
      {
        sourceId: a,
        sourceHandle: null,
      }
    )
    expect(id).toBeTruthy()
    const s = useStore.getState()
    expect(s.nodes).toHaveLength(2)
    expect(s.edges).toHaveLength(1)
    expect(s.edges[0]).toMatchObject({ source: a, target: id })
    expect(s.selectedNodeIds).toEqual([id])
    // One undo entry restores the lone source node.
    useStore.temporal.getState().undo()
    expect(useStore.getState().nodes).toHaveLength(1)
    expect(useStore.getState().edges).toHaveLength(0)
  })

  it("preserves the source handle of a branch node", () => {
    const useStore = createEditorStore(emptyWorkflow())
    const br = useStore.getState().addNode("flow.branch", { x: 0, y: 0 })
    const id = useStore.getState().addNodeConnected(
      "ai.prompt",
      { x: 320, y: 0 },
      {
        sourceId: br,
        sourceHandle: "true",
      }
    )
    expect(useStore.getState().edges[0].sourceHandle).toBe("true")
    expect(id).toBeTruthy()
  })

  it("returns null when the connection would be invalid (target is a trigger source-only rule)", () => {
    const useStore = createEditorStore(emptyWorkflow())
    const a = useStore.getState().addNode("ai.prompt", { x: 0, y: 0 })
    // Connecting INTO a trigger is illegal — but addNodeConnected always creates
    // the *target*, so craft an invalid case via a self-targeting source id.
    const res = useStore.getState().addNodeConnected(
      "ai.prompt",
      { x: 1, y: 1 },
      {
        sourceId: "ghost_source",
        sourceHandle: null,
      }
    )
    // ghost source isn't in the graph → endpoint missing → invalid → null.
    expect(res).toBeNull()
    expect(useStore.getState().nodes.find((n) => n.id === a)).toBeTruthy()
  })
})

describe("editor store — replaceSelectionWithNode (C5)", () => {
  it("replaces the selection with one node and rewires boundary edges (one undo)", () => {
    const useStore = createEditorStore(emptyWorkflow())
    const trig = useStore.getState().addNode("trigger.manual", { x: 0, y: 0 })
    const a = useStore.getState().addNode("ai.prompt", { x: 100, y: 0 })
    const b = useStore.getState().addNode("ai.prompt", { x: 200, y: 0 })
    const ext = useStore.getState().addNode("ai.prompt", { x: 300, y: 0 })
    useStore.getState().connect({ source: trig, target: a })
    useStore.getState().connect({ source: a, target: b })
    useStore.getState().connect({ source: b, target: ext })

    const newId = useStore.getState().replaceSelectionWithNode(
      [a, b],
      { kind: "flow.subworkflow", params: { workflowId: "wf_child" }, position: { x: 150, y: 0 } },
      {
        inbound: [{ source: trig, sourceHandle: undefined }],
        outbound: [{ target: ext, targetHandle: undefined }],
      }
    )
    const s = useStore.getState()
    // trig, ext, and the new node remain (a + b removed).
    expect(s.nodes.map((n) => n.id).sort()).toEqual([ext, newId, trig].sort())
    // Rewired: trig → new → ext.
    expect(s.edges.some((e) => e.source === trig && e.target === newId)).toBe(true)
    expect(s.edges.some((e) => e.source === newId && e.target === ext)).toBe(true)
    expect(s.edges).toHaveLength(2)
    expect(s.nodes.find((n) => n.id === newId)?.data.params).toEqual({ workflowId: "wf_child" })

    // One undo restores the original 4 nodes + 3 edges.
    useStore.temporal.getState().undo()
    expect(useStore.getState().nodes).toHaveLength(4)
    expect(useStore.getState().edges).toHaveLength(3)
  })

  it("dedupes multiple inbound edges from the same source/handle", () => {
    const useStore = createEditorStore(emptyWorkflow())
    const src = useStore.getState().addNode("trigger.manual", { x: 0, y: 0 })
    const a = useStore.getState().addNode("ai.prompt", { x: 100, y: 0 })
    const newId = useStore.getState().replaceSelectionWithNode(
      [a],
      { kind: "flow.subworkflow", params: { workflowId: "w" }, position: { x: 0, y: 0 } },
      {
        inbound: [
          { source: src, sourceHandle: undefined },
          { source: src, sourceHandle: undefined },
        ],
        outbound: [],
      }
    )
    expect(useStore.getState().edges.filter((e) => e.target === newId)).toHaveLength(1)
  })
})

describe("editor store — setBulkOnError (C6 bulk)", () => {
  it("sets onError across the selection while preserving each node's retry", () => {
    const useStore = createEditorStore(emptyWorkflow())
    const a = useStore.getState().addNode("ai.prompt", { x: 0, y: 0 })
    const b = useStore.getState().addNode("action.connector.send", { x: 100, y: 0 })
    // Give 'a' a retry config that must survive the bulk onError change.
    useStore.getState().updateNodeData(a, {
      errorHandling: { retry: { maxRetries: 3, retryIntervalMs: 250, backoff: "fixed" } },
    })
    useStore.getState().setBulkOnError([a, b], "continue")
    const nodeA = useStore.getState().nodes.find((n) => n.id === a)!
    const nodeB = useStore.getState().nodes.find((n) => n.id === b)!
    expect(nodeA.data.errorHandling?.onError).toBe("continue")
    expect(nodeA.data.errorHandling?.retry).toEqual({
      maxRetries: 3,
      retryIntervalMs: 250,
      backoff: "fixed",
    })
    expect(nodeB.data.errorHandling?.onError).toBe("continue")
  })

  it("clears the onError override (and empty errorHandling) when set to 'fail'", () => {
    const useStore = createEditorStore(emptyWorkflow())
    const a = useStore.getState().addNode("ai.prompt", { x: 0, y: 0 })
    useStore.getState().setBulkOnError([a], "continue")
    expect(useStore.getState().nodes.find((n) => n.id === a)!.data.errorHandling?.onError).toBe(
      "continue"
    )
    useStore.getState().setBulkOnError([a], "fail")
    // No retry → errorHandling collapses to undefined.
    expect(useStore.getState().nodes.find((n) => n.id === a)!.data.errorHandling).toBeUndefined()
  })
})
