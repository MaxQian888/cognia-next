import type { PluginContext } from "@cognia/plugin-sdk"

import { DEEP_RESEARCH_SKILL, registerResearchSkill } from "./skill"

describe("DEEP_RESEARCH_SKILL", () => {
  it("is an inline, global playbook gated to the deep_research tool", () => {
    expect(DEEP_RESEARCH_SKILL.id).toBe("deep-research")
    expect(DEEP_RESEARCH_SKILL.scope).toBe("global")
    expect(DEEP_RESEARCH_SKILL.allowedTools).toEqual(["deep_research"])
    expect(DEEP_RESEARCH_SKILL.source.kind).toBe("inline")
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

describe("registerResearchSkill", () => {
  it("registers the skill on the agent registry", () => {
    const registerSkill = jest.fn()
    const ctx = { agent: { registerSkill } } as unknown as PluginContext
    registerResearchSkill(ctx)
    expect(registerSkill).toHaveBeenCalledWith(DEEP_RESEARCH_SKILL)
  })
})
