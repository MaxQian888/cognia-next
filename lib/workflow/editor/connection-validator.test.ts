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
    expect(r).toEqual({
      valid: false,
      reason: "Self-loops are not allowed.",
      reasonKey: "selfLoop",
    })
  })

  it("rejects unknown endpoints", () => {
    const r = validateConnection({ source: "a", target: "z" }, NODES, [])
    expect(r.valid).toBe(false)
    if (!r.valid) expect(r.reason).toMatch(/missing/i)
  })

  it("rejects edges that target a trigger", () => {
    const r = validateConnection({ source: "a", target: "trg" }, NODES, [])
    expect(r).toEqual({
      valid: false,
      reason: "Triggers are sources only.",
      reasonKey: "triggerTarget",
    })
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
      reasonKey: "duplicateEdge",
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

  it("attaches stable reason keys for i18n", () => {
    const r = validateConnection({ source: "a", target: "a" }, NODES, [])
    expect(r).toMatchObject({ valid: false, reasonKey: "selfLoop" })
  })
})

describe("validateConnection — labeled output handles (v2)", () => {
  const branchV2: NodeShapeForValidation = {
    id: "br",
    data: { kind: "flow.branch", typeVersion: 2, params: {} },
  }
  const switchV2: NodeShapeForValidation = {
    id: "sw",
    data: {
      kind: "flow.switch",
      typeVersion: 2,
      params: { cases: [{ id: "c_a", label: "A", when: { combinator: "all", conditions: [] } }] },
    },
  }
  const nodes = [...NODES, branchV2, switchV2]

  it("accepts edges from a declared handle", () => {
    expect(
      validateConnection({ source: "br", target: "a", sourceHandle: "true" }, nodes, [])
    ).toEqual({ valid: true })
    expect(
      validateConnection({ source: "sw", target: "a", sourceHandle: "c_a" }, nodes, [])
    ).toEqual({ valid: true })
    expect(
      validateConnection({ source: "sw", target: "a", sourceHandle: "default" }, nodes, [])
    ).toEqual({ valid: true })
  })

  it("always accepts the error handle", () => {
    expect(
      validateConnection({ source: "br", target: "a", sourceHandle: "error" }, nodes, [])
    ).toEqual({ valid: true })
  })

  it("rejects an unknown sourceHandle on a handle-bearing node", () => {
    const r = validateConnection({ source: "sw", target: "a", sourceHandle: "c_gone" }, nodes, [])
    expect(r).toMatchObject({ valid: false, reasonKey: "unknownHandle" })
  })

  it("rejects a handle-less edge leaving a handle-bearing node", () => {
    const r = validateConnection({ source: "br", target: "a" }, nodes, [])
    expect(r).toMatchObject({ valid: false, reasonKey: "handleRequired" })
  })

  it("v1 nodes are unaffected (no params/typeVersion in shape)", () => {
    expect(validateConnection({ source: "a", target: "b" }, nodes, [])).toEqual({ valid: true })
  })
})

describe("validateConnection — error-handle gating", () => {
  const httpNode: NodeShapeForValidation = {
    id: "http",
    data: { kind: "io.http", typeVersion: 1, params: {} },
  }
  const httpWithBranch: NodeShapeForValidation = {
    id: "http_eb",
    data: {
      kind: "io.http",
      typeVersion: 1,
      params: {},
      errorHandling: { onError: "errorBranch" },
    },
  }
  const nodes = [...NODES, httpNode, httpWithBranch]

  it("rejects an error edge when the node has not opted into errorBranch", () => {
    const r = validateConnection(
      { source: "http", target: "a", sourceHandle: "error" },
      nodes,
      [],
      { errorPolicy: "stop" }
    )
    expect(r).toMatchObject({ valid: false, reasonKey: "errorHandleDisabled" })
  })

  it("accepts an error edge when the node opted into errorBranch", () => {
    expect(
      validateConnection({ source: "http_eb", target: "a", sourceHandle: "error" }, nodes, [], {
        errorPolicy: "stop",
      })
    ).toEqual({ valid: true })
  })

  it("accepts an error edge under the legacy workflow-level branch policy", () => {
    expect(
      validateConnection({ source: "http", target: "a", sourceHandle: "error" }, nodes, [], {
        errorPolicy: "branch",
      })
    ).toEqual({ valid: true })
  })

  it("stays permissive when no options are passed (shape-only callers)", () => {
    expect(
      validateConnection({ source: "http", target: "a", sourceHandle: "error" }, nodes, [])
    ).toEqual({ valid: true })
  })
})
