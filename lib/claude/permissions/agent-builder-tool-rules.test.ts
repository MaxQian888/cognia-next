import { AGENT_BUILDER_TOOL_NAMES } from "@/lib/claude/agent-builder-builtin-tools"
import { buildAgentBuilderToolRuleset } from "./agent-builder-tool-rules"

const PREFIX = "mcp__cognia-plugin-tools__"

describe("buildAgentBuilderToolRuleset", () => {
  it("allows reading, listing and writing the draft without a prompt, on both name forms", () => {
    const rules = buildAgentBuilderToolRuleset()
    for (const tool of [
      AGENT_BUILDER_TOOL_NAMES.getDraft,
      AGENT_BUILDER_TOOL_NAMES.listCatalog,
      AGENT_BUILDER_TOOL_NAMES.updateDraft,
    ]) {
      expect(rules[tool]).toBe("allow")
      expect(rules[`${PREFIX}${tool}`]).toBe("allow")
    }
  })

  it("asks before creating the agent, on both name forms", () => {
    const rules = buildAgentBuilderToolRuleset()
    expect(rules.agent_builder_create_agent).toBe("ask")
    expect(rules[`${PREFIX}agent_builder_create_agent`]).toBe("ask")
  })

  it("covers exactly the builder tools and nothing else", () => {
    const rules = buildAgentBuilderToolRuleset()
    const tools = Object.values(AGENT_BUILDER_TOOL_NAMES)
    expect(Object.keys(rules).sort()).toEqual(
      [...tools, ...tools.map((tool) => `${PREFIX}${tool}`)].sort()
    )
  })

  it("returns a fresh ruleset on every call", () => {
    const a = buildAgentBuilderToolRuleset()
    const b = buildAgentBuilderToolRuleset()
    expect(a).not.toBe(b)
    expect(a).toEqual(b)
  })
})
