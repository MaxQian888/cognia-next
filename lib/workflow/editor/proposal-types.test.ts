import { summarizeOps, type ProposalOp } from "./proposal-types"

describe("summarizeOps", () => {
  it("counts every proposal operation and preserves versioned add-node inputs", () => {
    const ops: ProposalOp[] = [
      {
        type: "add_node",
        nodeId: "n1",
        kind: "flow.branch",
        typeVersion: 1,
        position: { x: 0, y: 0 },
      },
      { type: "remove_node", nodeId: "n2" },
      { type: "connect_edge", edgeId: "e1", source: "n1", target: "n2" },
      { type: "disconnect_edge", edgeId: "e2" },
      { type: "configure_node", nodeId: "n1", patch: { label: "Branch" } },
    ]

    expect(ops[0]).toMatchObject({ typeVersion: 1 })
    expect(summarizeOps(ops)).toEqual({
      add: 1,
      remove: 1,
      connect: 1,
      disconnect: 1,
      configure: 1,
    })
  })
})
