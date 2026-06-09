import { describe, expect, it } from "@jest/globals"
import { computeExpressionDiagnostics } from "./expression-diagnostics"
import type { GraphEdgeLike, GraphNodeLike } from "./upstream-graph"

const nodes: GraphNodeLike[] = [
  { id: "a", kind: "trigger.manual" },
  { id: "b", kind: "ai.prompt" },
  { id: "c", kind: "ai.prompt" },
]
// a → b → c
const edges: GraphEdgeLike[] = [
  { source: "a", target: "b" },
  { source: "b", target: "c" },
]

describe("computeExpressionDiagnostics", () => {
  it("returns nothing for text without $node references", () => {
    expect(computeExpressionDiagnostics("plain {{ $vars.X }}", "c", nodes, edges)).toEqual([])
  })

  it("accepts an upstream reference", () => {
    expect(computeExpressionDiagnostics("{{ $node['a'].x }}", "c", nodes, edges)).toEqual([])
  })

  it("flags an unknown node reference as an error with correct char range", () => {
    const text = "hi {{ $node['ghost'].x }}"
    const diags = computeExpressionDiagnostics(text, "c", nodes, edges)
    expect(diags).toHaveLength(1)
    expect(diags[0]).toMatchObject({ code: "unknownNode", severity: "error", ref: "ghost" })
    // The flagged span must be exactly the $node[...] token.
    expect(text.slice(diags[0].from, diags[0].to)).toBe("$node['ghost']")
  })

  it("flags a downstream/sibling reference as a not-upstream warning", () => {
    // From b, referencing c (downstream) is out of scope.
    const diags = computeExpressionDiagnostics("{{ $node['c'].x }}", "b", nodes, edges)
    expect(diags).toHaveLength(1)
    expect(diags[0]).toMatchObject({ code: "notUpstream", severity: "warning", ref: "c" })
  })

  it("flags a self reference as not-upstream", () => {
    const diags = computeExpressionDiagnostics("{{ $node['b'] }}", "b", nodes, edges)
    expect(diags[0]?.code).toBe("notUpstream")
  })

  it("ignores $node text outside a mustache block", () => {
    // Not inside {{ }} → literal, never evaluated → no diagnostic.
    expect(computeExpressionDiagnostics("see $node['ghost'] in docs", "c", nodes, edges)).toEqual(
      []
    )
  })

  it("handles multiple references across multiple blocks", () => {
    const text = "{{ $node['a'].x }} and {{ $node['ghost'].y }} and {{ $node['c'].z }}"
    const diags = computeExpressionDiagnostics(text, "b", nodes, edges)
    // a is upstream (ok), ghost unknown (error), c downstream (warning).
    expect(diags.map((d) => d.code).sort()).toEqual(["notUpstream", "unknownNode"])
  })
})
