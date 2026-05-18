import {
  buildEdgeIndex,
  getEdgeById,
  getEdgeIndex,
  getIncomingEdgeIds,
  getOutgoingEdgeIds,
  hasEdgeBetween,
} from "./edge-index"
import type { RFWorkflowEdge } from "./react-flow-converter"

function edge(id: string, source: string, target: string): RFWorkflowEdge {
  return { id, source, target, type: "default" }
}

describe("edge-index", () => {
  describe("buildEdgeIndex", () => {
    it("indexes by id, by outgoing source, and by incoming target", () => {
      const edges: RFWorkflowEdge[] = [
        edge("e1", "a", "b"),
        edge("e2", "a", "c"),
        edge("e3", "b", "c"),
      ]
      const idx = buildEdgeIndex(edges)

      expect(idx.byId.size).toBe(3)
      expect(idx.byId.get("e2")?.target).toBe("c")

      expect(idx.outgoingByNodeId.get("a")).toEqual(["e1", "e2"])
      expect(idx.outgoingByNodeId.get("b")).toEqual(["e3"])
      expect(idx.outgoingByNodeId.get("c")).toBeUndefined()

      expect(idx.incomingByNodeId.get("c")).toEqual(["e2", "e3"])
      expect(idx.incomingByNodeId.get("a")).toBeUndefined()
    })

    it("handles an empty edges array without allocating", () => {
      const idx = buildEdgeIndex([])
      expect(idx.byId.size).toBe(0)
      expect(idx.outgoingByNodeId.size).toBe(0)
      expect(idx.incomingByNodeId.size).toBe(0)
    })
  })

  describe("getEdgeIndex (WeakMap cache)", () => {
    it("returns the same index instance for the same edges array reference", () => {
      const edges: RFWorkflowEdge[] = [edge("e1", "a", "b")]
      const first = getEdgeIndex(edges)
      const second = getEdgeIndex(edges)
      expect(first).toBe(second)
    })

    it("returns a fresh index when the array identity changes (mutation pattern)", () => {
      const a: RFWorkflowEdge[] = [edge("e1", "a", "b")]
      const b: RFWorkflowEdge[] = [...a, edge("e2", "b", "c")]
      const idxA = getEdgeIndex(a)
      const idxB = getEdgeIndex(b)
      expect(idxA).not.toBe(idxB)
      expect(idxB.byId.size).toBe(2)
    })
  })

  describe("query helpers", () => {
    const edges: RFWorkflowEdge[] = [
      edge("e1", "a", "b"),
      edge("e2", "a", "c"),
      edge("e3", "b", "c"),
      edge("e4", "c", "a"),
    ]

    it("getEdgeById returns the matching edge or undefined", () => {
      expect(getEdgeById(edges, "e2")?.source).toBe("a")
      expect(getEdgeById(edges, "nope")).toBeUndefined()
    })

    it("getOutgoingEdgeIds returns ids in insertion order, frozen empty array when none", () => {
      expect(getOutgoingEdgeIds(edges, "a")).toEqual(["e1", "e2"])
      const empty = getOutgoingEdgeIds(edges, "z")
      expect(empty.length).toBe(0)
      // Confirm the shared empty array is reused for orphan nodes.
      expect(getOutgoingEdgeIds(edges, "another-orphan")).toBe(empty)
    })

    it("getIncomingEdgeIds mirrors outgoing on the target side", () => {
      expect(getIncomingEdgeIds(edges, "a")).toEqual(["e4"])
      expect(getIncomingEdgeIds(edges, "c")).toEqual(["e2", "e3"])
      expect(getIncomingEdgeIds(edges, "z")).toEqual([])
    })

    it("hasEdgeBetween returns true only when a direct edge from→to exists", () => {
      expect(hasEdgeBetween(edges, "a", "b")).toBe(true)
      expect(hasEdgeBetween(edges, "c", "a")).toBe(true)
      expect(hasEdgeBetween(edges, "a", "z")).toBe(false)
      // Transitive paths don't count — direct only.
      expect(hasEdgeBetween(edges, "a", "c")).toBe(true) // e2 is direct
      expect(hasEdgeBetween(edges, "b", "a")).toBe(false)
    })

    it("hasEdgeBetween short-circuits when source has no outgoing edges", () => {
      expect(hasEdgeBetween(edges, "z", "a")).toBe(false)
    })
  })
})
