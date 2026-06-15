import { buildDagAscii, nodeGlyph, type DagNodeLike, type DagEdgeLike } from "./workflow-dag"

const node = (id: string, type: string, label?: string): DagNodeLike => ({
  id,
  type,
  ...(label ? { data: { label } } : {}),
})

describe("nodeGlyph", () => {
  it("maps each node category to a distinct glyph", () => {
    expect(nodeGlyph("trigger.cron")).toBe("◆")
    expect(nodeGlyph("action.connector.send")).toBe("⚙")
    expect(nodeGlyph("ai.prompt")).toBe("✦")
    expect(nodeGlyph("flow.branch")).toBe("◇")
    expect(nodeGlyph("data.map")).toBe("▤")
    expect(nodeGlyph("io.http")).toBe("⇄")
    expect(nodeGlyph("annotation.note")).toBe("▾")
  })
})

describe("buildDagAscii", () => {
  it("renders a placeholder for an empty graph", () => {
    expect(buildDagAscii([], [])).toContain("empty workflow")
  })

  it("prints an optional title heading", () => {
    expect(buildDagAscii([node("a", "ai.prompt")], [], { title: "Structure" })).toContain(
      "## Structure"
    )
  })

  it("layers a linear chain by dependency depth", () => {
    const nodes = [
      node("t", "trigger.cron", "On schedule"),
      node("p", "ai.prompt", "Summarize"),
      node("s", "action.connector.send", "Notify"),
    ]
    const edges: DagEdgeLike[] = [
      { source: "t", target: "p" },
      { source: "p", target: "s" },
    ]
    const out = buildDagAscii(nodes, edges)
    expect(out).toContain("Layer 1:")
    expect(out).toContain("Layer 2:")
    expect(out).toContain("Layer 3:")
    // Trigger precedes prompt precedes send.
    expect(out.indexOf("On schedule")).toBeLessThan(out.indexOf("Summarize"))
    expect(out.indexOf("Summarize")).toBeLessThan(out.indexOf("Notify"))
    // Each node lists its downstream target.
    expect(out).toContain("→ Summarize")
    expect(out).toContain("→ Notify")
  })

  it("places a fan-out's children in the same layer", () => {
    const nodes = [
      node("t", "trigger.manual", "Start"),
      node("a", "ai.prompt", "Branch A"),
      node("b", "ai.prompt", "Branch B"),
    ]
    const edges: DagEdgeLike[] = [
      { source: "t", target: "a" },
      { source: "t", target: "b" },
    ]
    const out = buildDagAscii(nodes, edges)
    const layer2 = out.slice(out.indexOf("Layer 2:"))
    expect(layer2).toContain("Branch A")
    expect(layer2).toContain("Branch B")
  })

  it("groups cyclic nodes (no entry point) into a trailing section", () => {
    const nodes = [node("a", "flow.set", "A"), node("b", "flow.set", "B")]
    const edges: DagEdgeLike[] = [
      { source: "a", target: "b" },
      { source: "b", target: "a" },
    ]
    const out = buildDagAscii(nodes, edges)
    expect(out).toContain("Cycle (no entry point):")
    expect(out).toContain("A")
    expect(out).toContain("B")
  })

  it("drops dangling edges whose endpoints are missing", () => {
    const nodes = [node("a", "ai.prompt", "Only")]
    const edges: DagEdgeLike[] = [{ source: "a", target: "ghost" }]
    const out = buildDagAscii(nodes, edges)
    expect(out).toContain("Only")
    expect(out).not.toContain("→ ghost")
  })

  it("falls back to the node id when there is no label", () => {
    expect(buildDagAscii([node("n_42", "ai.prompt")], [])).toContain("n_42")
  })

  it("truncates beyond maxNodes with a count note", () => {
    const nodes = Array.from({ length: 5 }, (_, i) => node(`n${i}`, "ai.prompt", `N${i}`))
    const out = buildDagAscii(nodes, [], { maxNodes: 2 })
    expect(out).toContain("more node(s)")
  })
})
