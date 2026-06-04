import { TOPIC_DISCOVERY_TEMPLATE } from "./template"
import { nodeKind } from "../ids"
import { SAVE_TOPICS_KIND } from "../nodes/save-topics"

describe("TOPIC_DISCOVERY_TEMPLATE", () => {
  const t = TOPIC_DISCOVERY_TEMPLATE

  it("is an automation template with a stable id", () => {
    expect(t.id).toBe("zhihu-topic-discovery")
    expect(t.category).toBe("automation")
  })

  it("wires cron → zget hot (terminal) → ai.prompt → save-topics", () => {
    const byId = Object.fromEntries(t.nodes.map((n) => [n.id, n]))
    expect(byId.trigger.type).toBe("trigger.cron")
    expect(byId.scan.type).toBe("action.system.terminal")
    expect(String(byId.scan.data.params?.command)).toContain("zget hot")
    expect(byId.rank.type).toBe("ai.prompt")
    expect(byId.save.type).toBe(nodeKind(SAVE_TOPICS_KIND))
  })

  it("is a clean DAG: every edge references real nodes and there is no cycle", () => {
    const ids = new Set(t.nodes.map((n) => n.id))
    for (const e of t.edges) {
      expect(ids.has(e.source)).toBe(true)
      expect(ids.has(e.target)).toBe(true)
    }
    // Linear chain trigger→scan→rank→save has exactly 3 edges, no back-edges.
    expect(t.edges).toHaveLength(3)
    const targets = t.edges.map((e) => e.target)
    expect(targets).not.toContain("trigger")
  })

  it("declares its plugin node as a requirement and needs no MCP preset", () => {
    expect(t.requires?.pluginNodeKinds).toEqual([nodeKind(SAVE_TOPICS_KIND)])
    expect(t.requires?.mcpServerPresetIds).toBeUndefined()
  })

  it("passes the terminal output into the ranking prompt and the rank output into save", () => {
    const byId = Object.fromEntries(t.nodes.map((n) => [n.id, n]))
    // No `.out` wrapper — the runtime exposes the raw executor output at
    // `upstream[id]` (lib/workflow/editor/expr-ref.ts); `.out.` paths
    // silently resolve to undefined.
    expect(String(byId.rank.data.params?.userPrompt)).toContain("$node['scan'].output")
    expect(String(byId.rank.data.params?.userPrompt)).not.toContain(".out.")
    expect(String(byId.save.data.params?.candidates)).toContain("$node['rank'].completion")
    expect(String(byId.save.data.params?.candidates)).not.toContain(".out.")
  })
})
