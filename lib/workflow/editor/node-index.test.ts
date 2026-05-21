import { buildNodeIndex, getNodeById, getNodeIndex } from "./node-index"
import type { RFWorkflowNode } from "./react-flow-converter"

function node(id: string, kind: string = "ai.prompt"): RFWorkflowNode {
  return {
    id,
    type: "workflowNode" as const,
    position: { x: 0, y: 0 },
    data: {
      kind: kind as RFWorkflowNode["data"]["kind"],
      typeVersion: 1,
      label: id,
      params: {},
    },
  }
}

describe("node-index", () => {
  describe("buildNodeIndex", () => {
    it("indexes every node by id", () => {
      const nodes: RFWorkflowNode[] = [node("a"), node("b", "flow.branch"), node("c")]
      const idx = buildNodeIndex(nodes)

      expect(idx.byId.size).toBe(3)
      expect(idx.byId.get("a")?.id).toBe("a")
      expect(idx.byId.get("b")?.data.kind).toBe("flow.branch")
      expect(idx.byId.get("missing")).toBeUndefined()
    })

    it("handles an empty nodes array without allocating", () => {
      const idx = buildNodeIndex([])
      expect(idx.byId.size).toBe(0)
    })

    it("when ids collide the later node wins (matches `new Map(nodes.map(...))` semantics)", () => {
      const first = node("dup", "ai.prompt")
      const second = node("dup", "flow.branch")
      const idx = buildNodeIndex([first, second])
      expect(idx.byId.size).toBe(1)
      expect(idx.byId.get("dup")).toBe(second)
    })
  })

  describe("getNodeIndex (WeakMap cache)", () => {
    it("returns the same index instance for the same nodes array reference", () => {
      const nodes: RFWorkflowNode[] = [node("a")]
      const first = getNodeIndex(nodes)
      const second = getNodeIndex(nodes)
      expect(first).toBe(second)
    })

    it("returns a fresh index when the array identity changes (mutation pattern)", () => {
      const a: RFWorkflowNode[] = [node("a")]
      const b: RFWorkflowNode[] = [...a, node("b")]
      const idxA = getNodeIndex(a)
      const idxB = getNodeIndex(b)
      expect(idxA).not.toBe(idxB)
      expect(idxB.byId.size).toBe(2)
    })
  })

  describe("getNodeById", () => {
    const nodes: RFWorkflowNode[] = [node("a"), node("b"), node("c")]

    it("returns the matching node or undefined", () => {
      expect(getNodeById(nodes, "b")?.id).toBe("b")
      expect(getNodeById(nodes, "nope")).toBeUndefined()
    })

    it("reads through the cached index on subsequent calls", () => {
      const first = getNodeIndex(nodes)
      const result = getNodeById(nodes, "a")
      expect(result).toBe(first.byId.get("a"))
    })
  })
})
