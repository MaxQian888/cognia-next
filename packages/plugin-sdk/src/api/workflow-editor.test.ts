import * as sdk from "./workflow-editor"

describe("plugin-sdk: api/workflow-editor", () => {
  it("coerces every supported proposal operation and rejects malformed input", () => {
    expect(sdk.coerceProposalOp(null, 0)).toBe("op 0: must be an object")
    expect(sdk.coerceProposalOp({ type: "future" }, 1)).toBe('op 1: unknown op type "future"')
    expect(
      sdk.coerceProposalOp(
        {
          type: "add_node",
          nodeId: "node-1",
          kind: "start",
          position: { x: 10, y: 20 },
          typeVersion: 1,
          data: { label: "Start" },
        },
        2
      )
    ).toMatchObject({ type: "add_node", nodeId: "node-1", kind: "start" })
    expect(sdk.coerceProposalOp({ type: "remove_node", nodeId: "node-1" }, 3)).toEqual({
      type: "remove_node",
      nodeId: "node-1",
    })
    expect(
      sdk.coerceProposalOp(
        {
          type: "connect_edge",
          edgeId: "edge-1",
          source: "node-1",
          target: "node-2",
          label: "next",
        },
        4
      )
    ).toMatchObject({ type: "connect_edge", edgeId: "edge-1", label: "next" })
    expect(sdk.coerceProposalOp({ type: "disconnect_edge", edgeId: "edge-1" }, 5)).toEqual({
      type: "disconnect_edge",
      edgeId: "edge-1",
    })
    expect(
      sdk.coerceProposalOp(
        { type: "configure_node", nodeId: "node-1", patch: { label: "Begin" } },
        6
      )
    ).toEqual({
      type: "configure_node",
      nodeId: "node-1",
      patch: { label: "Begin" },
    })
    expect(
      sdk.coerceProposalOp(
        { type: "add_node", nodeId: "node", kind: "start", position: { x: "bad", y: 0 } },
        7
      )
    ).toBe("op 7: x is invalid")
  })

  it("summarizes operations and creates a stable semantic revision", () => {
    const ops = [
      { type: "add_node", nodeId: "a", kind: "trigger.manual", position: { x: 0, y: 0 } },
      { type: "remove_node", nodeId: "b" },
      { type: "connect_edge", edgeId: "e", source: "a", target: "b" },
      { type: "disconnect_edge", edgeId: "e" },
      { type: "configure_node", nodeId: "a", patch: { label: "A" } },
    ] as Parameters<typeof sdk.summarizeOps>[0]
    expect(sdk.summarizeOps(ops)).toEqual({
      add: 1,
      remove: 1,
      connect: 1,
      disconnect: 1,
      configure: 1,
    })

    const first = sdk.workflowEditorRevision({
      nodes: [
        { id: "b", selected: true, data: { z: 1, a: 2 } },
        { id: "a", position: { x: 1, y: 2 } },
      ],
      edges: [{ id: "e", source: "a", target: "b", measured: { width: 10 } }],
    })
    const second = sdk.workflowEditorRevision({
      nodes: [
        { id: "a", position: { y: 2, x: 1 } },
        { id: "b", selected: false, data: { a: 2, z: 1 } },
      ],
      edges: [{ id: "e", source: "a", target: "b" }],
    })
    expect(first).toMatch(/^wf:[0-9a-f]{8}$/)
    expect(second).toBe(first)
  })

  it("exports only portable helpers rather than live host stores", () => {
    expect(sdk.ELK_DIRECTIONS).toEqual({ LR: "RIGHT", RL: "LEFT", TB: "DOWN", BT: "UP" })
    expect(sdk).not.toHaveProperty("getEditorStore")
    expect(sdk).not.toHaveProperty("useProposalStore")
    expect(sdk).not.toHaveProperty("autoLayout")
  })
})
