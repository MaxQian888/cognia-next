import type { VisualWorkflow, WorkflowNode } from "@/types/workflow/visual"
import { checkDesktopOnly } from "./desktop-only"

function node(id: string, type: string): WorkflowNode {
  return {
    id,
    type: type as WorkflowNode["type"],
    typeVersion: 1,
    position: { x: 0, y: 0 },
    data: { label: id, params: {} },
  }
}

function wf(nodes: WorkflowNode[]): VisualWorkflow {
  return {
    id: "w",
    schemaVersion: 1,
    name: "T",
    createdAt: 0,
    updatedAt: 0,
    nodes,
    edges: [],
    settings: {
      errorPolicy: "stop",
      timeoutMs: 1000,
      concurrency: 1,
      retryDefaults: { attempts: 1, backoff: "fixed", baseMs: 0 },
    },
  }
}

describe("checkDesktopOnly", () => {
  const w = wf([node("a", "trigger.manual"), node("term", "action.system.terminal")])

  it("is silent in desktop mode", () => {
    expect(checkDesktopOnly(w, false)).toEqual([])
  })

  it("warns on a desktop-only node in web mode", () => {
    const diags = checkDesktopOnly(w, true)
    expect(diags).toHaveLength(1)
    expect(diags[0]).toMatchObject({ code: "desktopOnlyInWeb", nodeId: "term" })
  })
})
