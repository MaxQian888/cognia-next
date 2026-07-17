import type { VisualWorkflow, WorkflowNode } from "@/types/workflow/visual"
import { checkLoopBodyJoinPolicy, checkReachability } from "./graph-structure"

function node(id: string, type = "ai.prompt", extra: Partial<WorkflowNode> = {}): WorkflowNode {
  return {
    id,
    type: type as WorkflowNode["type"],
    typeVersion: 1,
    position: { x: 0, y: 0 },
    data: { label: id, params: {} },
    ...extra,
  }
}

function wf(nodes: WorkflowNode[], edges: VisualWorkflow["edges"] = []): VisualWorkflow {
  return {
    id: "w",
    schemaVersion: 1,
    name: "T",
    createdAt: 0,
    updatedAt: 0,
    nodes,
    edges,
    settings: {
      errorPolicy: "stop",
      timeoutMs: 1000,
      concurrency: 1,
      retryDefaults: { attempts: 1, backoff: "fixed", baseMs: 0 },
    },
  }
}

describe("checkReachability", () => {
  it("returns nothing when there is no trigger (missingTrigger covers it)", () => {
    expect(checkReachability(wf([node("a"), node("b")]))).toEqual([])
  })

  it("does not flag annotations or container members as orphans", () => {
    const w = wf(
      [
        node("t", "trigger.manual"),
        node("note", "annotation.note"),
        node("loop", "flow.loop", { typeVersion: 2 }),
        node("child", "flow.set", { parentId: "loop" }),
      ],
      [{ id: "e1", source: "t", target: "loop" }]
    )
    // note (annotation) and child (container member) must NOT be orphans.
    expect(checkReachability(w)).toEqual([])
  })

  it("flags a node unreachable from the trigger", () => {
    const w = wf(
      [node("t", "trigger.manual"), node("reached"), node("island")],
      [{ id: "e1", source: "t", target: "reached" }]
    )
    const diags = checkReachability(w)
    expect(diags).toHaveLength(1)
    expect(diags[0]).toMatchObject({ code: "orphanNode", nodeId: "island" })
  })
})

describe("checkLoopBodyJoinPolicy", () => {
  it("warns for an any/race join inside a loop body (degrades to all at run time)", () => {
    const w = wf([
      node("t", "trigger.manual"),
      node("loop", "flow.loop", { typeVersion: 2 }),
      node("j", "flow.join", {
        parentId: "loop",
        data: { label: "j", params: { joinPolicy: "race" } },
      }),
    ])
    const diags = checkLoopBodyJoinPolicy(w)
    expect(diags).toHaveLength(1)
    expect(diags[0]).toMatchObject({
      code: "joinPolicyInLoop",
      nodeId: "j",
      severity: "warning",
      messageParams: { policy: "race" },
    })
  })

  it("stays silent for all-policy body joins and for top-level any/race joins", () => {
    const w = wf([
      node("t", "trigger.manual"),
      node("loop", "flow.loop", { typeVersion: 2 }),
      node("j_all", "flow.join", {
        parentId: "loop",
        data: { label: "j", params: { joinPolicy: "all" } },
      }),
      node("j_top", "flow.join", { data: { label: "j", params: { joinPolicy: "any" } } }),
    ])
    expect(checkLoopBodyJoinPolicy(w)).toEqual([])
  })
})
