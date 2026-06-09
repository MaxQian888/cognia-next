import { describe, expect, it } from "@jest/globals"
import type { VisualWorkflow, WorkflowNode } from "@/types/workflow/visual"
import { checkCredentials, checkKindAvailability } from "./availability"

function node(id: string, extra: Partial<WorkflowNode["data"]> = {}): WorkflowNode {
  return {
    id,
    type: "action.connector.send" as WorkflowNode["type"],
    typeVersion: 1,
    position: { x: 0, y: 0 },
    data: { label: id, params: {}, ...extra },
  }
}

function wf(nodes: WorkflowNode[], credentials?: VisualWorkflow["credentials"]): VisualWorkflow {
  return {
    id: "w",
    schemaVersion: 1,
    name: "T",
    createdAt: 0,
    updatedAt: 0,
    nodes,
    edges: [],
    credentials,
    settings: {
      errorPolicy: "stop",
      timeoutMs: 1000,
      concurrency: 1,
      retryDefaults: { attempts: 1, backoff: "fixed", baseMs: 0 },
    },
  }
}

describe("checkCredentials", () => {
  it("returns nothing when a node has no credential refs", () => {
    expect(checkCredentials(wf([node("a")]))).toEqual([])
  })

  it("flags a missing credential and dedupes repeated refs on one node", () => {
    const w = wf([node("a", { credentialRefs: { key1: "cred_x", key2: "cred_x" } })])
    const diags = checkCredentials(w)
    expect(diags).toHaveLength(1)
    expect(diags[0]).toMatchObject({ code: "credentialMissing", nodeId: "a" })
  })

  it("accepts a credential matched by map key or by id", () => {
    const byKey = wf([node("a", { credentialRefs: { key: "cred_x" } })], {
      cred_x: { id: "cred_x", name: "X" },
    })
    expect(checkCredentials(byKey)).toEqual([])
    const byId = wf([node("a", { credentialRefs: { key: "cred_x" } })], {
      slot: { id: "cred_x", name: "X" },
    })
    expect(checkCredentials(byId)).toEqual([])
  })
})

describe("checkKindAvailability", () => {
  it("warns only for unavailable kinds", () => {
    const w = wf([node("a")])
    expect(checkKindAvailability(w, () => true)).toEqual([])
    const diags = checkKindAvailability(w, () => false)
    expect(diags[0]).toMatchObject({
      code: "pluginUnavailable",
      nodeId: "a",
      messageParams: { kind: "action.connector.send" },
    })
  })
})
