import {
  validateConnection,
  type EdgeShapeForValidation,
  type NodeShapeForValidation,
} from "./connection-validator"
import type { WorkflowNodeKind } from "@/types/workflow/visual"

function node(id: string, kind: WorkflowNodeKind): NodeShapeForValidation {
  return { id, data: { kind } }
}

const NODES: NodeShapeForValidation[] = [
  node("trg", "trigger.manual"),
  node("a", "ai.prompt"),
  node("b", "data.transform"),
  node("note", "annotation.note"),
  node("group", "annotation.group"),
]

describe("validateConnection", () => {
  it("rejects when either endpoint is missing", () => {
    expect(validateConnection({ source: null, target: "a" }, NODES, [])).toMatchObject({
      valid: false,
    })
    expect(validateConnection({ source: "a", target: null }, NODES, [])).toMatchObject({
      valid: false,
    })
  })

  it("rejects self-loops", () => {
    const r = validateConnection({ source: "a", target: "a" }, NODES, [])
    expect(r).toEqual({ valid: false, reason: "Self-loops are not allowed." })
  })

  it("rejects unknown endpoints", () => {
    const r = validateConnection({ source: "a", target: "z" }, NODES, [])
    expect(r.valid).toBe(false)
    if (!r.valid) expect(r.reason).toMatch(/missing/i)
  })

  it("rejects edges that target a trigger", () => {
    const r = validateConnection({ source: "a", target: "trg" }, NODES, [])
    expect(r).toEqual({ valid: false, reason: "Triggers are sources only." })
  })

  it("rejects connections to/from annotation nodes", () => {
    expect(validateConnection({ source: "a", target: "note" }, NODES, [])).toMatchObject({
      valid: false,
    })
    expect(validateConnection({ source: "note", target: "a" }, NODES, [])).toMatchObject({
      valid: false,
    })
    expect(validateConnection({ source: "a", target: "group" }, NODES, [])).toMatchObject({
      valid: false,
    })
    expect(validateConnection({ source: "group", target: "a" }, NODES, [])).toMatchObject({
      valid: false,
    })
  })

  it("rejects exact-duplicate edges (incl. handle pair)", () => {
    const edges: EdgeShapeForValidation[] = [
      { source: "a", target: "b", sourceHandle: "out", targetHandle: "in" },
    ]
    const r = validateConnection(
      { source: "a", target: "b", sourceHandle: "out", targetHandle: "in" },
      NODES,
      edges
    )
    expect(r).toEqual({
      valid: false,
      reason: "Duplicate edge — these nodes are already connected.",
    })
  })

  it("treats undefined and null handles as the same value when deduping", () => {
    const edges: EdgeShapeForValidation[] = [
      { source: "a", target: "b" }, // both handles undefined
    ]
    const r = validateConnection(
      { source: "a", target: "b", sourceHandle: null, targetHandle: undefined },
      NODES,
      edges
    )
    expect(r.valid).toBe(false)
  })

  it("allows a parallel edge with a different handle pair", () => {
    const edges: EdgeShapeForValidation[] = [
      { source: "a", target: "b", sourceHandle: "out-1", targetHandle: "in" },
    ]
    const r = validateConnection(
      { source: "a", target: "b", sourceHandle: "out-2", targetHandle: "in" },
      NODES,
      edges
    )
    expect(r).toEqual({ valid: true })
  })

  it("accepts a normal trigger → action edge", () => {
    const r = validateConnection({ source: "trg", target: "a" }, NODES, [])
    expect(r).toEqual({ valid: true })
  })
})
