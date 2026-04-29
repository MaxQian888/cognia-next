import { buildAiSystemPrompt, buildAiUserPrompt } from "./ai-prompts"

describe("buildAiSystemPrompt", () => {
  it("returns a non-empty editor framing prompt", () => {
    const sys = buildAiSystemPrompt()
    expect(sys.length).toBeGreaterThan(50)
    expect(sys).toMatch(/SKILL\.md editor/i)
    expect(sys).toMatch(/respond with only/i)
  })
})

describe("buildAiUserPrompt", () => {
  it("includes the skill name and instruction text", () => {
    const out = buildAiUserPrompt("optimize", {
      name: "My Skill",
      description: "Short summary",
      content: "Body line\nSecond line",
    })
    expect(out).toMatch(/Skill name: My Skill/)
    expect(out).toMatch(/Description: Short summary/)
    expect(out).toMatch(/Tighten the phrasing/)
    expect(out).toMatch(/```markdown/)
    expect(out).toMatch(/Body line/)
  })

  it("uses the simplify wording for the simplify intent", () => {
    const out = buildAiUserPrompt("simplify", {
      name: "X",
      content: "y",
    })
    expect(out).toMatch(/plain language/i)
  })

  it("uses the expand wording for the expand intent", () => {
    const out = buildAiUserPrompt("expand", {
      name: "X",
      content: "y",
    })
    expect(out).toMatch(/concrete detail/i)
  })

  it("appends the validation list for the fixErrors intent", () => {
    const out = buildAiUserPrompt("fixErrors", {
      name: "X",
      content: "y",
      validationErrors: [
        { code: "missing-name", message: "Name is required." },
        { code: "missing-content", message: "Body is empty." },
      ],
    })
    expect(out).toMatch(/Validation issues to address:/)
    expect(out).toMatch(/Name is required\./)
    expect(out).toMatch(/Body is empty\./)
  })

  it("falls back to '(unnamed)' when name is empty", () => {
    const out = buildAiUserPrompt("optimize", { name: "", content: "y" })
    expect(out).toMatch(/Skill name: \(unnamed\)/)
  })

  it("omits Description when not provided", () => {
    const out = buildAiUserPrompt("optimize", { name: "X", content: "y" })
    expect(out).not.toMatch(/Description:/)
  })
})
