import { coerceProposalOp, KNOWN_PROPOSAL_OP_TYPES } from "./proposal-schema"
import type { ProposalOp } from "./proposal-types"

describe("coerceProposalOp", () => {
  it("accepts every valid op variant and preserves the discriminant", () => {
    const ops: ProposalOp[] = [
      { type: "add_node", nodeId: "n_a", kind: "trigger.manual", position: { x: 0, y: 0 } },
      {
        type: "add_node",
        nodeId: "n_b",
        kind: "ai.prompt",
        position: { x: 1, y: 2 },
        data: { label: "x", params: {} },
      },
      { type: "remove_node", nodeId: "n_a" },
      { type: "connect_edge", edgeId: "e1", source: "n_a", target: "n_b", label: "ok" },
      { type: "disconnect_edge", edgeId: "e1" },
      { type: "configure_node", nodeId: "n_a", patch: { label: "y" } },
    ]
    ops.forEach((op, i) => {
      const result = coerceProposalOp(op, i)
      expect(typeof result).not.toBe("string")
      expect(result).toMatchObject({ type: op.type })
    })
  })

  it("names the offending field for a malformed op (missing nodeId)", () => {
    const result = coerceProposalOp(
      { type: "add_node", kind: "trigger.manual", position: { x: 0, y: 0 } },
      0
    )
    expect(typeof result).toBe("string")
    expect(result as string).toMatch(/nodeId/)
  })

  it("rejects a non-object", () => {
    expect(coerceProposalOp(42, 3)).toMatch(/must be an object/)
  })

  it("rejects an unknown op type", () => {
    expect(coerceProposalOp({ type: "frobnicate" }, 1)).toMatch(/unknown op type/)
  })

  it("rejects add_node with a non-numeric position", () => {
    const result = coerceProposalOp(
      { type: "add_node", nodeId: "n", kind: "ai.prompt", position: { x: "0", y: 0 } },
      0
    )
    expect(typeof result).toBe("string")
  })

  it("preserves positive integer typeVersion values and rejects invalid versions", () => {
    const valid = coerceProposalOp(
      {
        type: "add_node",
        nodeId: "n",
        kind: "flow.branch",
        typeVersion: 1,
        position: { x: 0, y: 0 },
      },
      0
    )
    expect(valid).toMatchObject({ typeVersion: 1 })

    for (const typeVersion of [0, -1, 1.5, "1"]) {
      expect(
        coerceProposalOp(
          {
            type: "add_node",
            nodeId: "n",
            kind: "flow.branch",
            typeVersion,
            position: { x: 0, y: 0 },
          },
          0
        )
      ).toMatch(/typeVersion/)
    }
  })

  it("strips unknown top-level keys on a valid op", () => {
    const result = coerceProposalOp({ type: "remove_node", nodeId: "n_a", bogus: 1 }, 0)
    expect(result).toEqual({ type: "remove_node", nodeId: "n_a" })
  })

  it("exposes the known op types", () => {
    expect([...KNOWN_PROPOSAL_OP_TYPES].sort()).toEqual([
      "add_node",
      "configure_node",
      "connect_edge",
      "disconnect_edge",
      "remove_node",
    ])
  })
})
