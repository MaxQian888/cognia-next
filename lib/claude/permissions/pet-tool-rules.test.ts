import { PET_TOOL_NAMES, PET_SHOW_TOOL_NAME } from "@/lib/claude/pet-builtin-tools"
import { buildPetToolRuleset } from "./pet-tool-rules"

const NS = "mcp__cognia-plugin-tools__"

describe("buildPetToolRuleset", () => {
  const rules = buildPetToolRuleset()

  it("asks only for the tool that puts a window over the user's screen", () => {
    expect(rules[PET_SHOW_TOOL_NAME]).toBe("ask")
    for (const tool of PET_TOOL_NAMES) {
      if (tool === PET_SHOW_TOOL_NAME) continue
      expect(rules[tool]).toBe("allow")
    }
  })

  it("keys every tool twice, because the two provider paths see different names", () => {
    // The Anthropic path reaches canUseTool with the bare name and the AI-SDK
    // path with the namespaced one, and resolveToolVerdict matches exactly with
    // no prefix stripping. Keying one form applies the tier on one provider.
    for (const tool of PET_TOOL_NAMES) {
      expect(rules[tool]).toBeDefined()
      expect(rules[`${NS}${tool}`]).toBe(rules[tool])
    }
  })

  it("covers every shipped pet tool and nothing else", () => {
    const expected = new Set<string>()
    for (const tool of PET_TOOL_NAMES) {
      expected.add(tool)
      expected.add(`${NS}${tool}`)
    }
    expect(new Set(Object.keys(rules))).toEqual(expected)
  })
})
