import { buildSkillSystemPrompt, buildSkillUserPrompt } from "./trace-prompts"

describe("trace prompts", () => {
  it("system prompt asks for the SKILL.md sections and a JSON object", () => {
    const sys = buildSkillSystemPrompt()
    expect(sys).toContain("## When to use")
    expect(sys).toContain("## Inputs")
    expect(sys).toContain("## Steps")
    expect(sys).toContain("## Verify")
    expect(sys).toMatch(/JSON object/i)
    // Includes the valid category ids so the model picks a real one.
    expect(sys).toContain("productivity")
  })

  it("user prompt wraps the transcript", () => {
    const user = buildSkillUserPrompt("1. click Save")
    expect(user).toContain("Recorded workflow transcript:")
    expect(user).toContain("1. click Save")
  })
})
