import { downstream, topoSort, upstream } from "./topo-sort"
import type { VisualWorkflow } from "@/types/workflow/visual"

function wf(
  nodes: Array<{ id: string; type: VisualWorkflow["nodes"][number]["type"] }>,
  edges: Array<{ id: string; source: string; target: string }>
): VisualWorkflow {
  return {
    id: "wf",
    schemaVersion: 1,
    name: "x",
    createdAt: 0,
    updatedAt: 0,
    nodes: nodes.map((n) => ({
      id: n.id,
      type: n.type,
      typeVersion: 1,
      position: { x: 0, y: 0 },
      data: { label: n.id, params: {} },
    })),
    edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
    settings: {
      errorPolicy: "stop",
      timeoutMs: 60_000,
      concurrency: 1,
      retryDefaults: { attempts: 3, backoff: "exponential", baseMs: 1000 },
    },
  }
}

describe("topoSort", () => {
  it("orders a linear chain in source-to-target order", () => {
    const w = wf(
      [
        { id: "a", type: "trigger.manual" },
        { id: "b", type: "ai.prompt" },
        { id: "c", type: "flow.set" },
      ],
      [
        { id: "e1", source: "a", target: "b" },
        { id: "e2", source: "b", target: "c" },
      ]
    )
    expect(topoSort(w).order).toEqual(["a", "b", "c"])
  })

  it("preserves stable order across runs (deterministic on disconnected components)", () => {
    const w = wf(
      [
        { id: "a", type: "trigger.manual" },
        { id: "b", type: "trigger.manual" },
      ],
      []
    )
    const a = topoSort(w).order
    const b = topoSort(w).order
    expect(a).toEqual(b)
  })

  it("throws on a cycle through a flow.loop node instead of silently dropping the back-edge", () => {
    // The old "authorized back-edge" tolerance removed e3 and ran the graph
    // once — a validated-looking loop that never looped. Cycles now throw.
    const w = wf(
      [
        { id: "a", type: "trigger.manual" },
        { id: "loop", type: "flow.loop" },
        { id: "b", type: "ai.prompt" },
      ],
      [
        { id: "e1", source: "a", target: "loop" },
        { id: "e2", source: "loop", target: "b" },
        { id: "e3", source: "b", target: "loop" }, // back-edge
      ]
    )
    expect(() => topoSort(w)).toThrow(/flow\.loop container/)
  })

  it("keeps a linear chain through a flow.wait node sortable (no cycle, no throw)", () => {
    const w = wf(
      [
        { id: "a", type: "trigger.manual" },
        { id: "wait", type: "flow.wait" },
        { id: "b", type: "ai.prompt" },
      ],
      [
        { id: "e1", source: "a", target: "wait" },
        { id: "e2", source: "wait", target: "b" },
      ]
    )
    const r = topoSort(w)
    expect(r.order).toEqual(["a", "wait", "b"])
    expect(r.backEdges).toEqual([])
  })

  it("throws when a cycle has no flow.loop / flow.wait on it", () => {
    const w = wf(
      [
        { id: "a", type: "trigger.manual" },
        { id: "b", type: "ai.prompt" },
      ],
      [
        { id: "e1", source: "a", target: "b" },
        { id: "e2", source: "b", target: "a" },
      ]
    )
    expect(() => topoSort(w)).toThrow(/Cycle/)
  })
})

describe("downstream / upstream", () => {
  it("returns immediate neighbors", () => {
    const w = wf(
      [
        { id: "a", type: "trigger.manual" },
        { id: "b", type: "ai.prompt" },
        { id: "c", type: "flow.set" },
      ],
      [
        { id: "e1", source: "a", target: "b" },
        { id: "e2", source: "a", target: "c" },
      ]
    )
    expect(downstream(w, "a").sort()).toEqual(["b", "c"])
    expect(upstream(w, "b")).toEqual(["a"])
    expect(upstream(w, "a")).toEqual([])
  })
})
