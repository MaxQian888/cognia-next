import { buildProposalDoc, projectOps, type ProjectEdge } from "./workflow-proposal-doc"
import type { ProposalOp } from "@/lib/workflow/editor/proposal-types"
import type { DagNodeLike } from "./workflow-dag"

describe("projectOps", () => {
  const baseNodes: DagNodeLike[] = [{ id: "t", type: "trigger.manual", data: { label: "Start" } }]
  const baseEdges: ProjectEdge[] = []

  it("adds a node with its label", () => {
    const ops: ProposalOp[] = [
      {
        type: "add_node",
        nodeId: "p",
        kind: "ai.prompt",
        position: { x: 0, y: 0 },
        data: { label: "Think" },
      },
    ]
    const out = projectOps(baseNodes, baseEdges, ops)
    expect(out.nodes.find((n) => n.id === "p")?.data?.label).toBe("Think")
  })

  it("connects and then disconnects an edge by id", () => {
    const connect: ProposalOp[] = [{ type: "connect_edge", edgeId: "e1", source: "t", target: "t" }]
    const afterConnect = projectOps(baseNodes, baseEdges, connect)
    expect(afterConnect.edges).toHaveLength(1)
    const afterDisconnect = projectOps(baseNodes, afterConnect.edges, [
      { type: "disconnect_edge", edgeId: "e1" },
    ])
    expect(afterDisconnect.edges).toHaveLength(0)
  })

  it("removing a node drops its incident edges", () => {
    const nodes: DagNodeLike[] = [
      { id: "a", type: "ai.prompt" },
      { id: "b", type: "ai.prompt" },
    ]
    const edges: ProjectEdge[] = [{ id: "e", source: "a", target: "b" }]
    const out = projectOps(nodes, edges, [{ type: "remove_node", nodeId: "a" }])
    expect(out.nodes.map((n) => n.id)).toEqual(["b"])
    expect(out.edges).toHaveLength(0)
  })

  it("configure_node updates the label for the projection", () => {
    const out = projectOps(baseNodes, baseEdges, [
      { type: "configure_node", nodeId: "t", patch: { label: "Renamed" } },
    ])
    expect(out.nodes.find((n) => n.id === "t")?.data?.label).toBe("Renamed")
  })

  it("does not mutate the input arrays", () => {
    const nodes: DagNodeLike[] = [{ id: "a", type: "ai.prompt" }]
    projectOps(nodes, [], [{ type: "remove_node", nodeId: "a" }])
    expect(nodes).toHaveLength(1)
  })
})

describe("buildProposalDoc", () => {
  const ops: ProposalOp[] = [
    {
      type: "add_node",
      nodeId: "p",
      kind: "ai.prompt",
      position: { x: 0, y: 0 },
      data: { label: "Think" },
    },
    { type: "connect_edge", edgeId: "e1", source: "t", target: "p" },
  ]

  it("renders the summary, change tally, and per-op lines", () => {
    const doc = buildProposalDoc({ summary: "Add an AI step", ops })
    expect(doc).toContain("# Workflow proposal")
    expect(doc).toContain("Add an AI step")
    expect(doc).toContain("1 add")
    expect(doc).toContain("1 connect")
    expect(doc).toContain("Add node **Think**")
    expect(doc).toContain("Connect")
  })

  it("appends an 'after' topology when the current graph is supplied", () => {
    const doc = buildProposalDoc({
      summary: "x",
      ops,
      nodes: [{ id: "t", type: "trigger.manual", data: { label: "Start" } }],
      edges: [],
    })
    expect(doc).toContain("After applying")
    expect(doc).toContain("Think")
  })

  it("reports 'none' when there are no ops", () => {
    expect(buildProposalDoc({ summary: "", ops: [] })).toContain("**Changes:** none")
  })
})
