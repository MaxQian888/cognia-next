import { buildArtifactToolRuleset } from "./artifact-tool-rules"
import { ARTIFACT_TOOL_NAMES, CANVAS_TOOL_NAMES } from "@/lib/claude/artifact-builtin-tools"

describe("buildArtifactToolRuleset", () => {
  const rules = buildArtifactToolRuleset()

  it("asks before deleting user-visible work", () => {
    expect(rules.artifact_delete).toBe("ask")
    expect(rules["mcp__cognia-plugin-tools__artifact_delete"]).toBe("ask")
  })

  it("allows everything additive, visible, or read-only", () => {
    for (const tool of [...ARTIFACT_TOOL_NAMES, ...CANVAS_TOOL_NAMES]) {
      if (tool === "artifact_delete") continue
      expect(rules[tool]).toBe("allow")
    }
  })

  it("keys every tool twice — the two provider paths see different names", () => {
    // The Anthropic path reaches `canUseTool` with the bare name and the AI-SDK
    // path with the namespaced one; `resolveToolVerdict` matches exactly.
    // Keying one form applies the tier on one provider only.
    for (const tool of [...ARTIFACT_TOOL_NAMES, ...CANVAS_TOOL_NAMES]) {
      expect(rules[tool]).toBeDefined()
      expect(rules[`mcp__cognia-plugin-tools__${tool}`]).toBe(rules[tool])
    }
  })

  it("covers every shipped tool and nothing else", () => {
    const expected = [...ARTIFACT_TOOL_NAMES, ...CANVAS_TOOL_NAMES].flatMap((t) => [
      t,
      `mcp__cognia-plugin-tools__${t}`,
    ])
    expect(Object.keys(rules).sort()).toEqual(expected.sort())
  })
})
