import type { VisualWorkflow } from "@cognia/plugin-contract/types/workflow/visual"
import * as sdk from "./workflow-editor"

/** Three nodes, two edges, plus one edge whose source is not in the graph. */
function templateWorkflow(): VisualWorkflow {
  const node = (id: string, x: number) => ({
    id,
    type: "core.noop",
    position: { x, y: 0 },
    data: { label: id, params: { id } },
  })
  return {
    id: "wf_template",
    schemaVersion: 1,
    name: "template",
    nodes: [node("cron", 0), node("fetch", 200), node("Send Message!", 400)],
    edges: [
      { id: "e1", source: "cron", target: "fetch" },
      { id: "e2", source: "fetch", target: "Send Message!", sourceHandle: "out", label: "ok" },
      { id: "e3", source: "ghost", target: "fetch" },
    ],
    settings: {
      errorPolicy: "stop",
      timeoutMs: 60_000,
      concurrency: 1,
      retryDefaults: { attempts: 3, backoff: "exponential", baseMs: 1000, maxMs: 30_000 },
    },
    tags: [],
    createdAt: 0,
    updatedAt: 0,
  } as unknown as VisualWorkflow
}

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

  it("turns a template workflow into re-id'd add_node + connect_edge ops", () => {
    const wf = templateWorkflow()
    let counter = 0
    const { ops, idMap } = sdk.templateToProposalOps(
      wf,
      { nodeIds: new Set(), edgeIds: new Set() },
      () => `t${counter++}`
    )
    expect(idMap).toEqual({
      cron: "n_cron_t0",
      fetch: "n_fetch_t1",
      "Send Message!": "n_send_message__t2",
    })
    expect(ops.map((op) => op.type)).toEqual([
      "add_node",
      "add_node",
      "add_node",
      "connect_edge",
      "connect_edge",
    ])
    expect(ops[0]).toEqual({
      type: "add_node",
      nodeId: "n_cron_t0",
      kind: "core.noop",
      typeVersion: undefined,
      position: { x: 0, y: 0 },
      data: {
        label: "cron",
        params: { id: "cron" },
        notes: undefined,
        credentialRefs: undefined,
        disabled: undefined,
        authoredBy: "ai",
      },
    })
    // The dangling edge (source "ghost") is dropped; the others are translated.
    expect(ops[4]).toEqual({
      type: "connect_edge",
      edgeId: "e_t4",
      source: "n_fetch_t1",
      target: "n_send_message__t2",
      sourceHandle: "out",
      targetHandle: undefined,
      label: "ok",
    })
  })

  it("never reuses an id from the existing graph or from itself", () => {
    // n_cron_a and e_d already exist; the second "e" would repeat the first
    // edge's id inside the same proposal. Each collision draws the next id.
    const ids = ["a", "b", "b", "c", "d", "e", "e", "f"]
    const existing = { nodeIds: new Set(["n_cron_a"]), edgeIds: new Set(["e_d"]) }
    const { ops } = sdk.templateToProposalOps(templateWorkflow(), existing, () => ids.shift()!)
    expect(ops.flatMap((op) => (op.type === "add_node" ? [op.nodeId] : []))).toEqual([
      "n_cron_b",
      "n_fetch_b",
      "n_send_message__c",
    ])
    expect(ops.flatMap((op) => (op.type === "connect_edge" ? [op.edgeId] : []))).toEqual([
      "e_e",
      "e_f",
    ])
    expect(ids).toEqual([])
  })

  it("preserves each node's typeVersion", () => {
    const wf = templateWorkflow()
    wf.nodes[0] = { ...wf.nodes[0], typeVersion: 7 }
    let counter = 0
    const { ops, idMap } = sdk.templateToProposalOps(
      wf,
      { nodeIds: new Set(), edgeIds: new Set() },
      () => `s${counter++}`
    )
    expect(ops.find((op) => op.type === "add_node" && op.nodeId === idMap.cron)).toMatchObject({
      typeVersion: 7,
    })
  })

  it("exports only portable helpers rather than live host stores", () => {
    expect(sdk.ELK_DIRECTIONS).toEqual({ LR: "RIGHT", RL: "LEFT", TB: "DOWN", BT: "UP" })
    expect(sdk).not.toHaveProperty("getEditorStore")
    expect(sdk).not.toHaveProperty("useProposalStore")
    expect(sdk).not.toHaveProperty("autoLayout")
  })
})
