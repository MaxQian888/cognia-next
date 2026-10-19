import {
  SKILL_AI_INTENT_PROMPTS,
  SKILL_AI_REQUEST_PROMPT,
  SKILL_AI_SYSTEM_PROMPT,
  buildAiSystemPrompt,
  buildAiUserPrompt,
} from "./ai-prompts"
import {
  __setPromptOverrideSnapshotForTests,
  buildPromptOverrideSnapshot,
} from "@/lib/prompts/snapshot"
import { __resetPromptVerdictsForTests } from "@/lib/prompts/resolve"

describe("buildAiSystemPrompt", () => {
  it("returns a non-empty editor framing prompt", async () => {
    const sys = await buildAiSystemPrompt()
    expect(sys.length).toBeGreaterThan(50)
    expect(sys).toMatch(/SKILL\.md editor/i)
    expect(sys).toMatch(/respond with only/i)
  })
})

describe("buildAiUserPrompt", () => {
  it("includes the skill name and instruction text", async () => {
    const out = await buildAiUserPrompt("optimize", {
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

  it("uses the simplify wording for the simplify intent", async () => {
    const out = await buildAiUserPrompt("simplify", {
      name: "X",
      content: "y",
    })
    expect(out).toMatch(/plain language/i)
  })

  it("uses the expand wording for the expand intent", async () => {
    const out = await buildAiUserPrompt("expand", {
      name: "X",
      content: "y",
    })
    expect(out).toMatch(/concrete detail/i)
  })

  it("appends the validation list for the fixErrors intent", async () => {
    const out = await buildAiUserPrompt("fixErrors", {
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

  it("falls back to '(unnamed)' when name is empty", async () => {
    const out = await buildAiUserPrompt("optimize", { name: "", content: "y" })
    expect(out).toMatch(/Skill name: \(unnamed\)/)
  })

  it("omits Description when not provided", async () => {
    const out = await buildAiUserPrompt("optimize", { name: "X", content: "y" })
    expect(out).not.toMatch(/Description:/)
  })
})

describe("authoring prompts (ADR-0236)", () => {
  afterEach(() => {
    __setPromptOverrideSnapshotForTests(null)
    __resetPromptVerdictsForTests()
  })

  function override(promptId: string, revisionId: string, body: string) {
    return {
      bindingId: `pob-${revisionId}`,
      promptId,
      scope: "account" as const,
      targetId: "",
      revisionId,
      body,
      contractVersion: 1,
    }
  }

  it("renders the shipped request byte-for-byte", async () => {
    const out = await buildAiUserPrompt("fixErrors", {
      name: "X",
      description: " Summary ",
      content: "  body  ",
      validationErrors: [{ code: "missing-name", message: "Name is required." }],
    })
    expect(out).toBe(
      [
        "Skill name: X",
        "Description: Summary",
        "",
        "Instruction:",
        SKILL_AI_INTENT_PROMPTS.fixErrors.defaultBody,
        "",
        "Validation issues to address:",
        "- Name is required.",
        "",
        "Current SKILL.md body:",
        "```markdown",
        "body",
        "```",
        "",
        "Respond with the rewritten body only — no fenced wrapper, no leading or trailing prose.",
      ].join("\n")
    )
  })

  it("sends published system, intent and request overrides", async () => {
    __setPromptOverrideSnapshotForTests(
      buildPromptOverrideSnapshot("test-db", [
        override(SKILL_AI_SYSTEM_PROMPT.id, "por-skill-system", "You edit skills tersely."),
        override(SKILL_AI_INTENT_PROMPTS.optimize.id, "por-skill-optimize", "Halve the length."),
        override(
          SKILL_AI_REQUEST_PROMPT.id,
          "por-skill-request",
          "{{name}}: {{instruction}}\n{{content}}"
        ),
      ])
    )
    expect(await buildAiSystemPrompt()).toBe("You edit skills tersely.")
    expect(await buildAiUserPrompt("optimize", { name: "Deploy", content: "Run it." })).toBe(
      "Deploy: Halve the length.\nRun it."
    )
  })
})
