import { computeSplitEdges, edgeMidpoint } from "./edge-insert"

describe("computeSplitEdges", () => {
  it("preserves the source handle upstream and the target handle downstream", () => {
    const specs = computeSplitEdges(
      { source: "a", target: "b", sourceHandle: "true", targetHandle: "in" },
      "mid"
    )
    expect(specs.upstream).toEqual({ source: "a", target: "mid", sourceHandle: "true" })
    expect(specs.downstream).toEqual({ source: "mid", target: "b", targetHandle: "in" })
  })

  it("normalizes null handles to undefined", () => {
    const specs = computeSplitEdges(
      { source: "a", target: "b", sourceHandle: null, targetHandle: null },
      "mid"
    )
    expect(specs.upstream.sourceHandle).toBeUndefined()
    expect(specs.downstream.targetHandle).toBeUndefined()
  })
})

describe("edgeMidpoint", () => {
  it("averages the two endpoints", () => {
    expect(edgeMidpoint({ x: 0, y: 0 }, { x: 200, y: 100 })).toEqual({ x: 100, y: 50 })
  })
})
