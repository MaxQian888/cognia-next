import { toSubagentTemplate, toCharacterDraft } from "./convert"
import type { SubagentImportDraft } from "./types"

const BASE: SubagentImportDraft = {
  source: "claude-code",
  sourceKey: "claude-code:code-reviewer",
  name: "Code Reviewer",
  description: "Reviews code for bugs.",
  systemPrompt: "You are a senior reviewer.",
  tools: ["Read", "Grep"],
  model: "sonnet",
  providerHint: "anthropic",
  rawFrontmatter: { name: "code-reviewer" },
  sourceFile: ".claude/agents/code-reviewer.md",
  warnings: [],
}

describe("toSubagentTemplate", () => {
  it("maps the standard shape", () => {
    const t = toSubagentTemplate(BASE)
    expect(t.id).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(t.name).toBe("Code Reviewer")
    expect(t.description).toBe("Reviews code for bugs.")
    expect(t.category).toBe("general")
    expect(t.taskTemplate).toBe("{{task}}")
    expect(t.isBuiltIn).toBe(false)
    expect(t.createdAt).toBeInstanceOf(Date)
    expect(t.config.systemPrompt).toBe("You are a senior reviewer.")
    expect(t.config.tools).toEqual(["Read", "Grep"])
    expect(t.config.model).toBe("sonnet")
    expect(t.config.provider).toBe("anthropic")
    expect(t.config.maxSteps).toBe(10)
    expect(t.config.timeout).toBe(180_000)
    expect(t.config.priority).toBe("normal")
  })

  it("defaults description to empty string", () => {
    const t = toSubagentTemplate({ ...BASE, description: undefined })
    expect(t.description).toBe("")
  })

  it("drops unknown provider hints", () => {
    const t = toSubagentTemplate({
      ...BASE,
      providerHint: "galaxy" as SubagentImportDraft["providerHint"],
    })
    expect(t.config.provider).toBeUndefined()
  })

  it("maps 'gemini' provider hint to 'google'", () => {
    const t = toSubagentTemplate({ ...BASE, providerHint: "gemini" })
    expect(t.config.provider).toBe("google")
  })

  it("maps 'openai' provider hint to 'openai'", () => {
    const t = toSubagentTemplate({ ...BASE, providerHint: "openai" })
    expect(t.config.provider).toBe("openai")
  })

  it("generates unique ids on subsequent calls", () => {
    expect(toSubagentTemplate(BASE).id).not.toBe(toSubagentTemplate(BASE).id)
  })
})

describe("toCharacterDraft", () => {
  it("maps to CharacterDraft", () => {
    const c = toCharacterDraft(BASE)
    expect(c.name).toBe("Code Reviewer")
    expect(c.description).toBe("Reviews code for bugs.")
    expect(c.systemPrompt).toBe("You are a senior reviewer.")
    expect(c.model).toBe("sonnet")
    expect(c.allowedTools).toEqual(["Read", "Grep"])
    expect(c.permissionMode).toBe("default")
  })

  it("leaves avatarColor unset (createCharacter applies its default)", () => {
    const c = toCharacterDraft(BASE)
    expect(c.avatarColor).toBeUndefined()
  })

  it("preserves undefined optional fields", () => {
    const c = toCharacterDraft({ ...BASE, tools: undefined, model: undefined })
    expect(c.allowedTools).toBeUndefined()
    expect(c.model).toBeUndefined()
  })
})
