import { describe, expect, it } from "@jest/globals"
import {
  computeUpstreamNodeIds,
  isReferenceInScope,
  upstreamNodesFor,
  type GraphEdgeLike,
  type GraphNodeLike,
} from "./upstream-graph"

/**
 * Tiny graph builder — `n("a")` is an action node by default; pass a kind to
 * make triggers / loops / annotations. Edges are `"a>b"` shorthand.
 */
function n(id: string, kind = "action.noop"): GraphNodeLike {
  return { id, kind }
}
function e(spec: string): GraphEdgeLike {
  const [source, target] = spec.split(">")
  return { source, target }
}

describe("computeUpstreamNodeIds", () => {
  it("returns the transitive ancestors of a node in a linear chain", () => {
    const nodes = [n("a", "trigger.manual"), n("b"), n("c")]
    const edges = [e("a>b"), e("b>c")]
    expect(computeUpstreamNodeIds("c", nodes, edges)).toEqual(new Set(["a", "b"]))
    expect(computeUpstreamNodeIds("b", nodes, edges)).toEqual(new Set(["a"]))
    expect(computeUpstreamNodeIds("a", nodes, edges)).toEqual(new Set())
  })

  it("collects both arms of a diamond", () => {
    const nodes = [n("a", "trigger.manual"), n("b"), n("c"), n("d")]
    const edges = [e("a>b"), e("a>c"), e("b>d"), e("c>d")]
    expect(computeUpstreamNodeIds("d", nodes, edges)).toEqual(new Set(["a", "b", "c"]))
  })

  it("excludes annotation nodes from the ancestor set", () => {
    const nodes = [n("note", "annotation.note"), n("a", "trigger.manual"), n("b")]
    // A note can't actually connect, but defend against authored junk edges.
    const edges = [e("note>a"), e("a>b")]
    expect(computeUpstreamNodeIds("b", nodes, edges)).toEqual(new Set(["a"]))
  })

  it("treats an edge into a flow.loop as a back-edge so the loop body is not mutually upstream", () => {
    // body --> loop (back-edge), loop --> body (forward). Without back-edge
    // removal, `loop` and `body` would each appear upstream of the other.
    const nodes = [n("trig", "trigger.manual"), n("loop", "flow.loop"), n("body")]
    const edges = [e("trig>loop"), e("loop>body"), e("body>loop")]
    expect(computeUpstreamNodeIds("loop", nodes, edges)).toEqual(new Set(["trig"]))
    expect(computeUpstreamNodeIds("body", nodes, edges)).toEqual(new Set(["trig", "loop"]))
  })

  it("returns empty for an unknown node id", () => {
    const nodes = [n("a", "trigger.manual"), n("b")]
    const edges = [e("a>b")]
    expect(computeUpstreamNodeIds("ghost", nodes, edges)).toEqual(new Set())
  })

  it("treats a self-loop edge on a flow.loop node as a back-edge", () => {
    const nodes = [n("trig", "trigger.manual"), n("loop", "flow.loop")]
    const edges = [e("trig>loop"), e("loop>loop")]
    expect(computeUpstreamNodeIds("loop", nodes, edges)).toEqual(new Set(["trig"]))
  })

  it("is bounded by a visited set even on an unauthorized two-node cycle", () => {
    // x <-> y with no loop node — diagnostics flags this separately; the util
    // must still terminate and report them as mutually upstream.
    const nodes = [n("x"), n("y")]
    const edges = [e("x>y"), e("y>x")]
    expect(computeUpstreamNodeIds("x", nodes, edges)).toEqual(new Set(["y"]))
    expect(computeUpstreamNodeIds("y", nodes, edges)).toEqual(new Set(["x"]))
  })
})

describe("isReferenceInScope", () => {
  const nodes = [n("a", "trigger.manual"), n("b"), n("c")]
  const edges = [e("a>b"), e("b>c")]

  it("accepts an upstream reference", () => {
    expect(isReferenceInScope("c", "a", nodes, edges)).toBe(true)
    expect(isReferenceInScope("c", "b", nodes, edges)).toBe(true)
  })

  it("rejects a self reference", () => {
    expect(isReferenceInScope("b", "b", nodes, edges)).toBe(false)
  })

  it("rejects a downstream / sibling reference", () => {
    expect(isReferenceInScope("a", "c", nodes, edges)).toBe(false)
    expect(isReferenceInScope("b", "c", nodes, edges)).toBe(false)
  })
})

describe("upstreamNodesFor", () => {
  it("orders ancestors nearest-first with BFS distance", () => {
    const nodes = [n("a", "trigger.manual"), n("b"), n("c")]
    const edges = [e("a>b"), e("b>c")]
    const result = upstreamNodesFor("c", nodes, edges)
    expect(result.map((u) => u.id)).toEqual(["b", "a"])
    expect(result.find((u) => u.id === "b")?.distance).toBe(1)
    expect(result.find((u) => u.id === "a")?.distance).toBe(2)
  })

  it("omits annotations and the node itself", () => {
    const nodes = [n("a", "trigger.manual"), n("note", "annotation.note"), n("b")]
    const edges = [e("a>b")]
    expect(upstreamNodesFor("b", nodes, edges).map((u) => u.id)).toEqual(["a"])
    expect(upstreamNodesFor("a", nodes, edges)).toEqual([])
  })

  it("returns empty for an unknown node id", () => {
    expect(upstreamNodesFor("ghost", [n("a", "trigger.manual")], [])).toEqual([])
  })
})
