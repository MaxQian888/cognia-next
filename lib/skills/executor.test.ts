jest.mock("@/lib/db/skills", () => ({
  renderSkillsSection: jest.fn(() => "## Skills\n- A\n"),
}))

import { executeSkill, skillsExecutor, buildProgressiveSkillsPrompt } from "./executor"
import { renderSkillsSection } from "@/lib/db/skills"
import type { Skill } from "@cognia/agent-config-types"

const mockedRender = renderSkillsSection as unknown as jest.Mock

describe("executeSkill", () => {
  it("returns an empty execution result", async () => {
    const out = await executeSkill({ skillId: "x" })
    expect(out).toEqual({ output: "" })
  })
})

describe("skillsExecutor", () => {
  it("aliases executeSkill", async () => {
    const out = await skillsExecutor.execute({ skillId: "y" })
    expect(out.output).toBe("")
  })
})

describe("buildProgressiveSkillsPrompt", () => {
  it("delegates to renderSkillsSection", () => {
    mockedRender.mockReturnValueOnce("RENDERED")
    const skills: Skill[] = []
    const out = buildProgressiveSkillsPrompt(skills)
    expect(out).toEqual({ prompt: "RENDERED" })
    expect(mockedRender).toHaveBeenCalledWith(skills, {})
  })

  it("passes maxTokens down instead of dropping it", () => {
    mockedRender.mockReturnValueOnce("X")
    const out = buildProgressiveSkillsPrompt([], 1000)
    expect(out).toEqual({ prompt: "X" })
    expect(mockedRender).toHaveBeenCalledWith([], { maxTokens: 1000 })
  })

  it("forwards a degradation hook when one is given", () => {
    const onDegrade = jest.fn()
    mockedRender.mockReturnValueOnce("X")
    buildProgressiveSkillsPrompt([], 1000, onDegrade)
    expect(mockedRender).toHaveBeenCalledWith([], { maxTokens: 1000, onDegrade })
  })

  it("sends no budget at all when none was asked for", () => {
    mockedRender.mockReturnValueOnce("X")
    buildProgressiveSkillsPrompt([])
    expect(mockedRender).toHaveBeenCalledWith([], {})
  })
})
