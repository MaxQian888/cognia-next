import {
  reactFlowToWorkflow,
  workflowToReactFlow,
  type RFWorkflowEdge,
  type RFWorkflowNode,
} from "./react-flow-converter"
import type { VisualWorkflow } from "@/types/workflow/visual"

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
