import {
  buildClipboardEnvelope,
  cloneNodesAndEdges,
  CLIPBOARD_FORMAT,
  parseClipboard,
  rehydrateFromEnvelope,
  selectionBounds,
  serializeClipboard,
} from "./clipboard"
import type { RFWorkflowEdge, RFWorkflowNode } from "./react-flow-converter"

function node(id: string, x = 0, y = 0): RFWorkflowNode {
  return {
    id,
    type: "workflowNode",
    position: { x, y },
    data: {
      label: `Node ${id}`,
      params: {},
      kind: "trigger.manual",
      typeVersion: 1,
    },
  }
}

function edge(id: string, source: string, target: string): RFWorkflowEdge {
  return { id, source, target, type: "default" }
}

describe("cloneNodesAndEdges", () => {
  it("clones only the selected nodes and remaps edge endpoints", () => {
    const nodes = [node("a", 0, 0), node("b", 100, 0), node("c", 200, 0)]
    const edges = [edge("e1", "a", "b"), edge("e2", "b", "c")]
    const out = cloneNodesAndEdges(nodes, edges, ["a", "b"])
    expect(out.nodes).toHaveLength(2)
    expect(out.edges).toHaveLength(1) // only e1 has both endpoints in the selection
    const newA = out.idMap.get("a")!
    const newB = out.idMap.get("b")!
    expect(newA).not.toBe("a")
    expect(newB).not.toBe("b")
    expect(out.edges[0].source).toBe(newA)
    expect(out.edges[0].target).toBe(newB)
    // c was not selected → no entry
    expect(out.idMap.has("c")).toBe(false)
  })

  it("offsets positions by the default 24/24", () => {
    const out = cloneNodesAndEdges([node("a", 50, 80)], [], ["a"])
    expect(out.nodes[0].position).toEqual({ x: 74, y: 104 })
  })

  it("honours a custom offset", () => {
    const out = cloneNodesAndEdges([node("a", 0, 0)], [], ["a"], { x: 100, y: 0 })
    expect(out.nodes[0].position).toEqual({ x: 100, y: 0 })
  })

  it("strips runtime selection / dragging flags from clones", () => {
    const live: RFWorkflowNode = { ...node("a"), selected: true, dragging: true }
    const out = cloneNodesAndEdges([live], [], ["a"])
    expect(out.nodes[0].selected).toBe(false)
    expect(out.nodes[0].dragging).toBe(false)
  })

  it("returns empty arrays when nothing matches", () => {
    const out = cloneNodesAndEdges([node("a")], [edge("e1", "a", "b")], ["does-not-exist"])
    expect(out.nodes).toEqual([])
    expect(out.edges).toEqual([])
    expect(out.idMap.size).toBe(0)
  })
})

describe("envelope serialise / parse round-trip", () => {
  it("builds + serialises + parses back to the same envelope", () => {
    const env = buildClipboardEnvelope(
      [node("a", 0, 0), node("b", 100, 0)],
      [edge("e1", "a", "b")],
      ["a", "b"]
    )
    const text = serializeClipboard(env)
    const parsed = parseClipboard(text)
    expect(parsed?.format).toBe(CLIPBOARD_FORMAT)
    expect(parsed?.nodes).toHaveLength(2)
    expect(parsed?.edges).toHaveLength(1)
  })

  it("filters dangling edges in the envelope", () => {
    const env = buildClipboardEnvelope(
      [node("a"), node("b"), node("c")],
      [edge("e1", "a", "b"), edge("e2", "b", "c"), edge("e3", "c", "external")],
      ["a", "b"]
    )
    expect(env.nodes.map((n) => n.id)).toEqual(["a", "b"])
    expect(env.edges).toHaveLength(1)
    expect(env.edges[0].id).toBe("e1")
  })

  it("rejects null / non-JSON / wrong-format input", () => {
    expect(parseClipboard(null)).toBeNull()
    expect(parseClipboard("")).toBeNull()
    expect(parseClipboard("not json")).toBeNull()
    expect(parseClipboard(JSON.stringify({ random: "shape" }))).toBeNull()
    expect(
      parseClipboard(
        JSON.stringify({ format: CLIPBOARD_FORMAT, version: 99, nodes: [], edges: [] })
      )
    ).toBeNull()
  })

  it("rehydrates an envelope into fresh ids", () => {
    const env = buildClipboardEnvelope(
      [node("a", 10, 10), node("b", 100, 10)],
      [edge("e1", "a", "b")],
      ["a", "b"]
    )
    const out = rehydrateFromEnvelope(env)
    expect(out.nodes).toHaveLength(2)
    expect(out.nodes.every((n) => n.id !== "a" && n.id !== "b")).toBe(true)
    expect(out.edges).toHaveLength(1)
    expect(out.edges[0].source).toBe(out.idMap.get("a"))
    // Default offset applied
    expect(out.nodes[0].position).toEqual({ x: 34, y: 34 })
  })
})

describe("selectionBounds", () => {
  it("returns null on an empty selection", () => {
    expect(selectionBounds([], [])).toBeNull()
    expect(selectionBounds([node("a")], ["does-not-exist"])).toBeNull()
  })

  it("computes a tight bounding box including default node size", () => {
    const out = selectionBounds([node("a", 0, 0), node("b", 200, 100)], ["a", "b"])
    expect(out).toEqual({
      x: 0,
      y: 0,
      // Default size 240×80 → max corner (200+240, 100+80) = (440, 180)
      width: 440,
      height: 180,
    })
  })

  it("uses provided width/height on each node when present", () => {
    const a = { ...node("a", 0, 0), width: 100, height: 50 }
    const b = { ...node("b", 200, 0), width: 100, height: 50 }
    const out = selectionBounds([a, b], ["a", "b"])
    expect(out).toEqual({ x: 0, y: 0, width: 300, height: 50 })
  })
})
