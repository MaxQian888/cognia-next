import { DEEP_RESEARCH_SKILL } from "./skill"

describe("DEEP_RESEARCH_SKILL", () => {
  it("is an inline, global playbook gated to the deep_research tool", () => {
    expect(DEEP_RESEARCH_SKILL.id).toBe("cognia-deep-research:deep-research")
    expect(DEEP_RESEARCH_SKILL.slug).toBe("deep-research")
    expect(DEEP_RESEARCH_SKILL.scope).toBe("global")
    expect(DEEP_RESEARCH_SKILL.allowedTools).toEqual(["deep_research"])
    expect(DEEP_RESEARCH_SKILL.source.kind).toBe("inline")
  })

  it("describes itself to the user, not just to the model", () => {
    expect(DEEP_RESEARCH_SKILL.name).toBe("Deep Research playbook")
    expect(DEEP_RESEARCH_SKILL.description).toMatch(/deep_research/)
  })

  it("teaches the model when to reach for the tool and what depth means", () => {
    const markdown =
      DEEP_RESEARCH_SKILL.source.kind === "inline" ? DEEP_RESEARCH_SKILL.source.markdown : ""
    expect(markdown).toContain("deep_research")
    expect(markdown).toContain("quick")
    expect(markdown).toContain("deep")
    expect(markdown).toMatch(/citation/i)
  })
})
