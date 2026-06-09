import { describe, expect, it } from "@jest/globals"
import type { VisualWorkflow, WorkflowNode } from "@/types/workflow/visual"
import { checkExpressionRefs } from "./expression-refs"

function node(id: string, params: Record<string, unknown>, type = "ai.prompt"): WorkflowNode {
  return {
    id,
    type: type as WorkflowNode["type"],
    typeVersion: 1,
    position: { x: 0, y: 0 },
    data: { label: id, params },
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

describe("checkExpressionRefs", () => {
  it("flags a self-reference as not-upstream (warning)", () => {
    const w = wf([node("a", { userPrompt: "{{ $node['a'].out.x }}" })])
    const diags = checkExpressionRefs(w)
    expect(diags).toHaveLength(1)
    expect(diags[0].code).toBe("exprNotUpstream")
    expect(diags[0].messageParams?.ref).toBe("a")
  })

  it("walks nested objects and arrays for references", () => {
    const w = wf(
      [
        node("a", {}, "trigger.manual"),
        node("b", {
          nested: { items: ["plain", "{{ $node['ghost'].out.v }}"] },
        }),
      ],
      [{ id: "e1", source: "a", target: "b" }]
    )
    const diags = checkExpressionRefs(w)
    const unknown = diags.find((d) => d.code === "exprUnknownNode")
    expect(unknown?.messageParams?.ref).toBe("ghost")
    // field is the top-level param key
    expect(unknown?.field).toBe("nested")
  })

  it("ignores strings without a $node head token", () => {
    const w = wf([node("a", { userPrompt: "{{ $vars.KEY }} and {{ $trigger.payload }}" })])
    expect(checkExpressionRefs(w)).toEqual([])
  })

  it("skips nodes with no params object", () => {
    const orphanParams = node("a", undefined as unknown as Record<string, unknown>)
    expect(checkExpressionRefs(wf([orphanParams]))).toEqual([])
  })
})
