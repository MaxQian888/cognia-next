import {
  __setPromptOverrideSnapshotForTests,
  buildPromptOverrideSnapshot,
} from "@/lib/prompts/snapshot"
import { __resetPromptVerdictsForTests } from "@/lib/prompts/resolve"
import {
  DIFF_EXPLAIN_PROMPT,
  buildExplainSystemPrompt,
  buildExplainUserPrompt,
  generateDiffExplanation,
} from "./ai-explain"

afterEach(() => {
  __setPromptOverrideSnapshotForTests(null)
  __resetPromptVerdictsForTests()
})

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

describe("Prompt Center override", () => {
  it("sends a published override with the user's extra instructions still appended", async () => {
    __setPromptOverrideSnapshotForTests(
      buildPromptOverrideSnapshot("test-db", [
        {
          bindingId: "pob",
          promptId: DIFF_EXPLAIN_PROMPT.id,
          scope: "account",
          targetId: "",
          revisionId: "por-diff-explain",
          body: "Summarize this diff in one sentence.",
          contractVersion: DIFF_EXPLAIN_PROMPT.contractVersion,
        },
      ])
    )
    const complete = jest.fn().mockResolvedValue("ok")
    await generateDiffExplanation(
      { subject: "a.ts", diffText: "d", config: { customInstructions: "in French" } },
      { complete }
    )
    expect(complete.mock.calls[0][1].system).toBe(
      "Summarize this diff in one sentence.\nAdditional instructions: in French"
    )
  })

  it("sends the shipped text when nothing is published", async () => {
    const complete = jest.fn().mockResolvedValue("ok")
    await generateDiffExplanation({ subject: "a.ts", diffText: "d", config: {} }, { complete })
    expect(complete.mock.calls[0][1].system).toBe(DIFF_EXPLAIN_PROMPT.defaultBody)
  })
})
