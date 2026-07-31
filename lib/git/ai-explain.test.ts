import {
  buildExplainSystemPrompt,
  buildExplainUserPrompt,
  generateDiffExplanation,
} from "./ai-explain"

describe("buildExplainSystemPrompt", () => {
  it("asks for a brief plain-language what/why summary", () => {
    const p = buildExplainSystemPrompt({})
    expect(p).toContain("explain a Git diff")
    expect(p.toLowerCase()).toContain("what")
    expect(p.toLowerCase()).toContain("why")
  })

  it("appends custom instructions when present, and omits when blank", () => {
    expect(buildExplainSystemPrompt({ customInstructions: "in Chinese" })).toContain(
      "Additional instructions: in Chinese"
    )
    expect(buildExplainSystemPrompt({ customInstructions: "   " })).not.toContain(
      "Additional instructions"
    )
  })
})

describe("buildExplainUserPrompt", () => {
  it("labels the subject and fences the diff", () => {
    const prompt = buildExplainUserPrompt({
      subject: "src/a.ts",
      diffText: "@@ -1 +1 @@\n-a\n+b",
      config: {},
    })
    expect(prompt).toContain("Subject: src/a.ts")
    expect(prompt).toContain("```diff")
    expect(prompt).toContain("+b")
  })
})

describe("generateDiffExplanation", () => {
  it("calls the client and strips fences", async () => {
    const complete = jest.fn().mockResolvedValue("```\nRenames foo to bar.\n```")
    const out = await generateDiffExplanation(
      { subject: "src/a.ts", diffText: "diff", config: {} },
      { complete }
    )
    expect(out).toBe("Renames foo to bar.")
    const [prompt, options] = complete.mock.calls[0]
    expect(prompt).toContain("Subject: src/a.ts")
    expect(options.system).toContain("explain a Git diff")
  })
})
