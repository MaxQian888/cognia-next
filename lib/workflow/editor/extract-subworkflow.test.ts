import {
  planExtraction,
  type ExtractionEdgeLike,
  type ExtractionNodeLike,
} from "./extract-subworkflow"

const nodes: ExtractionNodeLike[] = [
  { id: "trig", position: { x: 0, y: 0 } },
  { id: "a", position: { x: 100, y: 0 } },
  { id: "b", position: { x: 200, y: 0 } },
  { id: "ext", position: { x: 300, y: 0 } },
]
// trig → a → b → ext (a,b selected)
const edges: ExtractionEdgeLike[] = [
  { id: "e0", source: "trig", target: "a" },
  { id: "e1", source: "a", target: "b" },
  { id: "e2", source: "b", target: "ext" },
]

describe("planExtraction", () => {
  it("returns null for an empty selection", () => {
    expect(planExtraction([], nodes, edges)).toBeNull()
  })

  it("partitions internal / inbound / outbound edges", () => {
    const plan = planExtraction(["a", "b"], nodes, edges)!
    expect(plan.internalEdgeIds).toEqual(["e1"])
    expect(plan.inbound).toEqual([
      { edgeId: "e0", externalSource: "trig", sourceHandle: undefined },
    ])
    expect(plan.outbound).toEqual([
      { edgeId: "e2", externalTarget: "ext", targetHandle: undefined },
    ])
  })

  it("computes the centroid of the selection", () => {
    const plan = planExtraction(["a", "b"], nodes, edges)!
    expect(plan.center).toEqual({ x: 150, y: 0 })
  })

  it("preserves source/target handles on boundary edges", () => {
    const e: ExtractionEdgeLike[] = [
      { id: "i1", source: "br", target: "a", sourceHandle: "true" },
      { id: "o1", source: "b", target: "ext", targetHandle: "in" },
    ]
    const n: ExtractionNodeLike[] = [
      { id: "br", position: { x: 0, y: 0 } },
      { id: "a", position: { x: 1, y: 0 } },
      { id: "b", position: { x: 2, y: 0 } },
      { id: "ext", position: { x: 3, y: 0 } },
    ]
    const plan = planExtraction(["a", "b"], n, e)!
    expect(plan.inbound[0].sourceHandle).toBe("true")
    expect(plan.outbound[0].targetHandle).toBe("in")
  })
})
