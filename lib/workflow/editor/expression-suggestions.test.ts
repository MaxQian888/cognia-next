import { buildExpressionSuggestions, probeOutputFields } from "./expression-suggestions"
import type { WorkflowNode } from "@/types/workflow/visual"

function n(id: string, type: WorkflowNode["type"], label?: string): WorkflowNode {
  return {
    id,
    type,
    typeVersion: 1,
    position: { x: 0, y: 0 },
    data: { label: label ?? id, params: {} },
  }
}

describe("buildExpressionSuggestions", () => {
  it("always includes the four top-level keywords", () => {
    const out = buildExpressionSuggestions({ nodes: [] })
    const labels = out.map((e) => e.label)
    expect(labels).toContain("$trigger")
    expect(labels).toContain("$static")
    expect(labels).toContain("$params")
    expect(labels).toContain("$trigger.kind")
  })

  it("emits trigger payload entries when triggerHints are provided", () => {
    const out = buildExpressionSuggestions({
      nodes: [],
      triggerHints: { kind: "trigger.webhook", payloadKeys: ["body", "headers"] },
    })
    expect(out.find((e) => e.label === "$trigger.payload.body")?.detail).toBe("trigger.webhook")
    expect(out.some((e) => e.label === "$trigger.payload.headers")).toBe(true)
  })

  it("emits one entry per static-data key", () => {
    const out = buildExpressionSuggestions({ nodes: [], staticKeys: ["counter", "user"] })
    const staticEntries = out.filter((e) => e.label.startsWith("$static."))
    expect(staticEntries.map((e) => e.label).sort()).toEqual(["$static.counter", "$static.user"])
  })

  it("includes the $vars keyword and one entry per workflow variable", () => {
    const out = buildExpressionSuggestions({ nodes: [], varKeys: ["API_BASE", "TOKEN"] })
    expect(out.some((e) => e.label === "$vars")).toBe(true)
    const varEntries = out.filter((e) => e.label.startsWith("$vars."))
    expect(varEntries.map((e) => e.label).sort()).toEqual(["$vars.API_BASE", "$vars.TOKEN"])
  })

  it("excludes the current node from per-node entries", () => {
    const nodes = [n("a", "ai.prompt"), n("b", "data.transform")]
    const out = buildExpressionSuggestions({ nodes, currentNodeId: "a" })
    expect(out.some((e) => e.label === "$node['a'].out")).toBe(false)
    expect(out.some((e) => e.label === "$node['b'].out")).toBe(true)
  })

  it("skips annotation nodes entirely", () => {
    const nodes = [
      n("note", "annotation.note"),
      n("group", "annotation.group"),
      n("p", "ai.prompt"),
    ]
    const out = buildExpressionSuggestions({ nodes })
    expect(out.some((e) => e.label.includes("'note'"))).toBe(false)
    expect(out.some((e) => e.label.includes("'group'"))).toBe(false)
    expect(out.some((e) => e.label === "$node['p'].out")).toBe(true)
  })

  it("expands per-node fields when outputSchemas is supplied", () => {
    const nodes = [n("p", "ai.prompt", "Prompt")]
    const out = buildExpressionSuggestions({
      nodes,
      outputSchemas: { p: ["completion", "model"] },
    })
    const fields = out.filter((e) => e.label.startsWith("$node['p'].out.")).map((e) => e.label)
    expect(fields).toContain("$node['p'].out.completion")
    expect(fields).toContain("$node['p'].out.model")
    // Generic fallback should NOT appear when real schema is provided.
    expect(fields).not.toContain("$node['p'].out.<field>")
  })

  it("falls back to a generic <field> placeholder when no schema is known", () => {
    const nodes = [n("x", "ai.prompt")]
    const out = buildExpressionSuggestions({ nodes })
    expect(out.some((e) => e.label === "$node['x'].out.<field>")).toBe(true)
  })

  it("uses node label + kind in the detail string when label is present", () => {
    const nodes = [n("greet", "ai.prompt", "Greeting prompt")]
    const out = buildExpressionSuggestions({ nodes })
    const baseRow = out.find((e) => e.label === "$node['greet'].out")
    expect(baseRow?.detail).toBe("Greeting prompt (ai.prompt)")
  })
})

describe("probeOutputFields", () => {
  it("returns top-level keys for plain objects", () => {
    expect(probeOutputFields({ a: 1, b: 2 })).toEqual(["a", "b"])
  })

  it("returns [] for arrays / primitives / nullish", () => {
    expect(probeOutputFields([])).toEqual([])
    expect(probeOutputFields(null)).toEqual([])
    expect(probeOutputFields(undefined)).toEqual([])
    expect(probeOutputFields("hi")).toEqual([])
    expect(probeOutputFields(42)).toEqual([])
  })
})
