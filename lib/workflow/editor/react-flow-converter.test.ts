import {
  reactFlowToWorkflow,
  workflowToReactFlow,
  type RFWorkflowEdge,
  type RFWorkflowNode,
} from "./react-flow-converter"
import { DEFAULT_WORKFLOW_SETTINGS, type VisualWorkflow } from "@/types/workflow/visual"

function sample(): VisualWorkflow {
  return {
    id: "wf_x",
    schemaVersion: 1,
    name: "Test",
    createdAt: 0,
    updatedAt: 0,
    nodes: [
      {
        id: "n1",
        type: "trigger.manual",
        typeVersion: 1,
        position: { x: 0, y: 0 },
        data: { label: "Run", params: { foo: "bar" }, notes: "hi" },
        width: 220,
        height: 80,
      },
      {
        id: "n2",
        type: "ai.prompt",
        typeVersion: 1,
        position: { x: 200, y: 0 },
        data: { label: "Prompt", params: {} },
      },
    ],
    edges: [
      { id: "e1", source: "n1", target: "n2", label: "next" },
      {
        id: "e2",
        source: "n2",
        target: "n1",
        data: { kind: "conditional" },
      },
    ],
    settings: {
      errorPolicy: "stop",
      timeoutMs: 60_000,
      concurrency: 1,
      retryDefaults: { attempts: 3, backoff: "exponential", baseMs: 1000 },
    },
    viewport: { x: 50, y: -50, zoom: 1.5 },
  }
}

describe("workflowToReactFlow → reactFlowToWorkflow round-trip", () => {
  it("preserves nodes, edges, viewport, and per-node data", () => {
    const base = sample()
    const converted = workflowToReactFlow(base)
    expect(converted.nodes).toHaveLength(2)
    expect(converted.edges).toHaveLength(2)
    expect(converted.viewport).toEqual({ x: 50, y: -50, zoom: 1.5 })

    const back = reactFlowToWorkflow(base, converted.nodes, converted.edges, converted.viewport)
    expect(back.nodes).toEqual(base.nodes)
    expect(back.edges).toEqual(base.edges)
    expect(back.viewport).toEqual(base.viewport)
  })

  it("carries per-node errorHandling through the save round-trip", () => {
    const base = sample()
    base.nodes[1].data.errorHandling = {
      retry: { maxRetries: 2, retryIntervalMs: 500, backoff: "exponential", maxIntervalMs: 5000 },
      onError: "errorBranch",
    }
    const converted = workflowToReactFlow(base)
    const back = reactFlowToWorkflow(base, converted.nodes, converted.edges, converted.viewport)
    expect(back.nodes[1].data.errorHandling).toEqual({
      retry: { maxRetries: 2, retryIntervalMs: 500, backoff: "exponential", maxIntervalMs: 5000 },
      onError: "errorBranch",
    })
  })

  it("flattens kind + typeVersion into node data so the renderer can dispatch on them", () => {
    const converted = workflowToReactFlow(sample())
    expect(converted.nodes[0].data.kind).toBe("trigger.manual")
    expect(converted.nodes[0].data.typeVersion).toBe(1)
  })

  it("annotates conditional edges with the right type", () => {
    const converted = workflowToReactFlow(sample())
    const e1 = converted.edges.find((e) => e.id === "e1")!
    const e2 = converted.edges.find((e) => e.id === "e2")!
    expect(e1.type).toBe("default")
    expect(e2.type).toBe("conditional")
    expect(e2.data?.workflowKind).toBe("conditional")
  })

  it("falls back to a zero viewport when the workflow lacks one", () => {
    const wf = sample()
    delete wf.viewport
    expect(workflowToReactFlow(wf).viewport).toEqual({ x: 0, y: 0, zoom: 1 })
  })

  it("strips React Flow's internal label types when an edge label isn't a string", () => {
    const base = sample()
    const converted = workflowToReactFlow(base)
    // Simulate React Flow having mutated the label to a non-string (e.g., a JSX node)
    const mutated: RFWorkflowEdge[] = converted.edges.map((e) =>
      e.id === "e1" ? { ...e, label: { type: "div" } as unknown as string } : e
    )
    const back = reactFlowToWorkflow(base, converted.nodes, mutated, converted.viewport)
    expect(back.edges.find((e) => e.id === "e1")?.label).toBeUndefined()
  })

  it("drops React Flow handle nullishness when serializing edges", () => {
    const base = sample()
    const converted = workflowToReactFlow(base)
    const withNullHandles: RFWorkflowEdge[] = converted.edges.map((e) => ({
      ...e,
      sourceHandle: null,
      targetHandle: null,
    }))
    const back = reactFlowToWorkflow(base, converted.nodes, withNullHandles, converted.viewport)
    expect(back.edges[0].sourceHandle).toBeUndefined()
    expect(back.edges[0].targetHandle).toBeUndefined()
  })

  it("serializes node width/height when present and omits them otherwise", () => {
    const base = sample()
    const converted = workflowToReactFlow(base)
    // Node 1 had width/height; node 2 didn't.
    const back = reactFlowToWorkflow(base, converted.nodes, converted.edges, converted.viewport)
    expect(back.nodes[0].width).toBe(220)
    expect(back.nodes[0].height).toBe(80)
    expect(back.nodes[1].width).toBeUndefined()

    // If React Flow sets non-numeric values, we must drop them.
    const broken: RFWorkflowNode[] = converted.nodes.map((n) => ({
      ...n,
      width: undefined,
      height: undefined,
    }))
    const back2 = reactFlowToWorkflow(base, broken, converted.edges, converted.viewport)
    expect(back2.nodes[0].width).toBeUndefined()
  })
})

describe("parentId + authoredBy round-trip", () => {
  function wf(): VisualWorkflow {
    return {
      id: "wf1",
      schemaVersion: 2,
      name: "n",
      createdAt: 1,
      updatedAt: 1,
      settings: DEFAULT_WORKFLOW_SETTINGS,
      edges: [],
      nodes: [
        {
          id: "loop",
          type: "flow.loop",
          typeVersion: 2,
          position: { x: 0, y: 0 },
          data: { label: "Loop", params: { mode: "forEach" } },
        },
        {
          id: "child",
          type: "ai.prompt",
          typeVersion: 1,
          parentId: "loop",
          position: { x: 10, y: 20 },
          data: { label: "AI", params: {}, authoredBy: "ai" },
        },
      ],
    }
  }

  it("carries parentId + extent into React Flow nodes", () => {
    const rf = workflowToReactFlow(wf())
    const child = rf.nodes.find((n) => n.id === "child")!
    expect(child.parentId).toBe("loop")
    expect(child.extent).toBe("parent")
  })

  it("restores parentId and authoredBy on the inverse trip", () => {
    const rf = workflowToReactFlow(wf())
    const back = reactFlowToWorkflow(wf(), rf.nodes, rf.edges, rf.viewport)
    const child = back.nodes.find((n) => n.id === "child")!
    expect(child.parentId).toBe("loop")
    expect(child.data.authoredBy).toBe("ai")
  })

  it("carries edge source/target handles through the forward map", () => {
    const base = wf()
    base.edges = [
      { id: "e1", source: "loop", sourceHandle: "done", target: "child", targetHandle: "in" },
    ]
    const rf = workflowToReactFlow(base)
    expect(rf.edges[0].sourceHandle).toBe("done")
    expect(rf.edges[0].targetHandle).toBe("in")
  })

  it("renders flow.loop v2 as the loopContainer node type (v1 stays workflowNode)", () => {
    const rf = workflowToReactFlow(wf())
    expect(rf.nodes.find((n) => n.id === "loop")?.type).toBe("loopContainer")

    const v1 = wf()
    v1.nodes[0] = { ...v1.nodes[0], typeVersion: 1 }
    const rf1 = workflowToReactFlow(v1)
    expect(rf1.nodes.find((n) => n.id === "loop")?.type).toBe("workflowNode")
  })

  it("orders parents before children regardless of authored order (React Flow v12 requirement)", () => {
    const base = wf()
    // Author the child FIRST — the converter must re-order.
    base.nodes = [base.nodes[1], base.nodes[0]]
    const rf = workflowToReactFlow(base)
    const loopIdx = rf.nodes.findIndex((n) => n.id === "loop")
    const childIdx = rf.nodes.findIndex((n) => n.id === "child")
    expect(loopIdx).toBeLessThan(childIdx)
  })

  it("tolerates a React Flow node with missing data on the inverse trip", () => {
    const rf = workflowToReactFlow(wf())
    const stripped = rf.nodes.map((n) =>
      n.id === "child" ? ({ ...n, data: undefined } as unknown as (typeof rf.nodes)[number]) : n
    )
    const back = reactFlowToWorkflow(wf(), stripped, rf.edges, rf.viewport)
    const child = back.nodes.find((n) => n.id === "child")!
    expect(child.data.params).toBeUndefined()
  })
})
