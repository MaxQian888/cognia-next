jest.mock("@cognia/document/knowledge-rag", () => ({
  buildProjectContext: jest.fn((project: unknown, _query: unknown) => {
    if (!project) return { systemPrompt: "", chunks: [] }
    return {
      systemPrompt: "[Project knowledge]\nFacts about " + (project as { id: string }).id,
      chunks: [],
    }
  }),
}))

jest.mock("@/lib/skills/executor", () => ({
  buildProgressiveSkillsPrompt: jest.fn((skills: Array<{ name?: string }>, _max: unknown) => ({
    prompt: skills.length ? "[Skills]\n" + skills.map((s) => s.name ?? "x").join(",") : "",
  })),
}))

import {
  buildCustomInstructionsSection,
  buildExternalAgentInstructionStack,
} from "./external-agent-instruction-stack"
import { buildProgressiveSkillsPrompt } from "@/lib/skills/executor"

describe("buildCustomInstructionsSection", () => {
  it("returns empty when disabled", () => {
    expect(
      buildCustomInstructionsSection({
        customInstructionsEnabled: false,
        aboutUser: "x",
        responsePreferences: "y",
        customInstructions: "z",
      })
    ).toBe("")
  })

  it("collects all three blocks when present", () => {
    const out = buildCustomInstructionsSection({
      customInstructionsEnabled: true,
      aboutUser: "alice",
      responsePreferences: "concise",
      customInstructions: "extra",
    })
    expect(out).toContain("[About the user]\nalice")
    expect(out).toContain("[Response preferences]\nconcise")
    expect(out).toContain("[Additional instructions]\nextra")
  })

  it("ignores empty fields", () => {
    expect(
      buildCustomInstructionsSection({
        customInstructionsEnabled: true,
        aboutUser: "  ",
        responsePreferences: "",
      })
    ).toBe("")
  })
})

describe("buildExternalAgentInstructionStack", () => {
  it("uses the default base prompt when none is provided", () => {
    const out = buildExternalAgentInstructionStack({})
    expect(out.systemPrompt).toMatch(/You are a helpful AI assistant/)
    expect(out.sourceFlags.hasBaseSystemPrompt).toBe(true)
    expect(out.sourceFlags.hasGlobalCustomInstructions).toBe(false)
    expect(out.sourceFlags.hasSkills).toBe(false)
    expect(out.sourceFlags.hasProjectInstructions).toBe(false)
    expect(out.sourceFlags.hasProjectKnowledge).toBe(false)
    expect(out.sourceFlags.hasWorkingDirectoryHint).toBe(false)
    expect(out.developerInstructions).toBe("")
    expect(out.customInstructionsSection).toBe("")
    expect(out.skillsSummary).toBe("")
    expect(out.instructionHash).toMatch(/^ins_/)
    expect(out.projectContextSummary).toBeUndefined()
  })

  it("includes custom instructions when enabled", () => {
    const out = buildExternalAgentInstructionStack({
      baseSystemPrompt: "Custom base.",
      customInstructionsEnabled: true,
      aboutUser: "Tester",
    })
    expect(out.systemPrompt).toContain("Custom base.")
    expect(out.systemPrompt).toContain("[About the user]\nTester")
    expect(out.sourceFlags.hasGlobalCustomInstructions).toBe(true)
  })

  it("incorporates project custom instructions and knowledge", () => {
    const out = buildExternalAgentInstructionStack({
      project: {
        id: "p1",
        name: "Proj",
        customInstructions: "  Be careful.  ",
        knowledgeBase: [{ id: "kb1" } as never],
      } as never,
      userQuery: "explain x",
    })
    expect(out.systemPrompt).toContain("[Project instructions]\nBe careful.")
    expect(out.systemPrompt).toContain("[Project knowledge]")
    expect(out.sourceFlags.hasProjectInstructions).toBe(true)
    expect(out.sourceFlags.hasProjectKnowledge).toBe(true)
    expect(out.projectContextSummary).toMatch(/^project:p1 knowledge:1/)
    expect(out.developerInstructions).toContain("Use the attached project context")
  })

  it("skips project knowledge call when knowledgeBase is empty", () => {
    const out = buildExternalAgentInstructionStack({
      project: {
        id: "p2",
        name: "Empty",
        customInstructions: "x",
        knowledgeBase: [],
      } as never,
    })
    expect(out.sourceFlags.hasProjectKnowledge).toBe(false)
    expect(out.projectContextSummary).toBeUndefined()
  })

  it("prepends the skills prompt and forwards maxSkillsTokens", () => {
    const out = buildExternalAgentInstructionStack({
      activeSkills: [{ id: "s1", name: "Spell-check", description: "fix typos" } as never],
      maxSkillsTokens: 1024,
    })
    expect(out.systemPrompt.startsWith("[Skills]")).toBe(true)
    expect(out.skillsSummary).toContain("- Spell-check: fix typos")
    expect(out.sourceFlags.hasSkills).toBe(true)
    expect(buildProgressiveSkillsPrompt).toHaveBeenCalledWith(expect.any(Array), 1024)
  })

  it("falls back to skill id and skip-description when name/description missing", () => {
    const out = buildExternalAgentInstructionStack({
      activeSkills: [{ id: "fallback-id" } as never],
    })
    expect(out.skillsSummary).toBe("- fallback-id")
  })

  it("includes a working directory hint and reflects it in developer instructions", () => {
    const out = buildExternalAgentInstructionStack({
      workingDirectory: "  /home/user/proj  ",
    })
    expect(out.sourceFlags.hasWorkingDirectoryHint).toBe(true)
    expect(out.developerInstructions).toContain("/home/user/proj")
  })

  it("produces a deterministic hash: same input → same hash", () => {
    const a = buildExternalAgentInstructionStack({
      baseSystemPrompt: "P",
      activeSkills: [{ id: "sk", name: "A", description: "x" } as never],
      workingDirectory: "/wd",
    })
    const b = buildExternalAgentInstructionStack({
      baseSystemPrompt: "P",
      activeSkills: [{ id: "sk", name: "A", description: "x" } as never],
      workingDirectory: "/wd",
    })
    expect(a.instructionHash).toBe(b.instructionHash)
  })

  it("hash differs when input differs", () => {
    const a = buildExternalAgentInstructionStack({ baseSystemPrompt: "X" })
    const b = buildExternalAgentInstructionStack({ baseSystemPrompt: "Y" })
    expect(a.instructionHash).not.toBe(b.instructionHash)
  })

  it("hash handles arrays, nested objects, and null/undefined values", () => {
    // Run twice with structurally identical (but newly-allocated) skill arrays
    // to exercise stableStringify for arrays + nested objects
    const a = buildExternalAgentInstructionStack({
      activeSkills: [{ id: "a", name: "A" } as never, { id: "b", name: "B" } as never],
    })
    const b = buildExternalAgentInstructionStack({
      activeSkills: [{ id: "a", name: "A" } as never, { id: "b", name: "B" } as never],
    })
    expect(a.instructionHash).toBe(b.instructionHash)
  })

  it("stableStringify handles null and undefined inside the hash payload", () => {
    // workingDirectory: null/undefined exercises the String(null|undefined) path
    const a = buildExternalAgentInstructionStack({
      workingDirectory: undefined,
      activeSkills: [{ id: "x" } as never],
    })
    expect(a.instructionHash).toMatch(/^ins_/)
  })
})
