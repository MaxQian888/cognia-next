import type { Character } from "@cognia/agent-config-types"
import {
  AGENT_AVATAR_COLORS,
  characterToEditorState,
  editorStateToOutput,
  emptyEditorState,
  normalizedEnvBindings,
  parseToolChips,
  validateEditorState,
} from "./editor-state"

const stored: Character = {
  id: "char_1",
  name: "Reviewer",
  description: "Reviews PRs",
  avatarColor: "#123456",
  avatarEmoji: "🔍",
  systemPrompt: "Review carefully.",
  modelRouting: { plan: "opus", execute: "sonnet", utility: "haiku" },
  executionPolicy: { effort: "high", maxTurns: 12 },
  permissionMode: "acceptEdits",
  allowedTools: ["Read", "Grep"],
  disallowedTools: ["Bash"],
  mcpServerIds: ["mcp-1"],
  skillIds: ["sk-1"],
  pluginSkillIds: ["plugin:skill"],
  knowledgeBaseIds: ["kb-1"],
  memoryPolicy: {
    operations: { recall: true, create: false, update: true, forget: false },
    readableScopes: ["global"],
    writableScopes: ["agent"],
    autoLearn: false,
  },
  workingDir: "/repo",
  briefMode: true,
  enableBrowserTools: true,
  enableComputerUse: true,
  computerUseTarget: { connectionId: "conn-1" },
  sandboxEnabled: true,
  sandboxTier: "os",
  accountIdOverride: "acct-1",
  runtime: { kind: "external", agentId: "codex", name: "Codex" },
  persona: {
    tone: "dry",
    personality: "exacting",
    openingMessage: "Hi",
    exemplarPrompts: ["a", "b"],
  },
  availableOnPlatforms: ["tauri"],
  providerId: "openrouter",
  createdAt: 1,
  updatedAt: 2,
}

describe("characterToEditorState → editorStateToOutput", () => {
  it("round-trips a stored agent's profile", () => {
    const out = editorStateToOutput(characterToEditorState(stored))
    expect(out).toMatchObject({
      name: "Reviewer",
      description: "Reviews PRs",
      avatarColor: "#123456",
      avatarEmoji: "🔍",
      systemPrompt: "Review carefully.",
      model: "sonnet",
      modelRouting: { plan: "opus", execute: "sonnet", utility: "haiku" },
      executionPolicy: { effort: "high", maxTurns: 12 },
      permissionMode: "acceptEdits",
      allowedTools: ["Read", "Grep"],
      disallowedTools: ["Bash"],
      mcpServerIds: ["mcp-1"],
      skillIds: ["sk-1"],
      pluginSkillIds: ["plugin:skill"],
      knowledgeBaseIds: ["kb-1"],
      memoryPolicy: stored.memoryPolicy,
      workingDir: "/repo",
      briefMode: true,
      enableBrowserTools: true,
      enableComputerUse: true,
      computerUseTarget: { connectionId: "conn-1" },
      sandboxEnabled: true,
      sandboxTier: "os",
      accountIdOverride: "acct-1",
      runtime: { kind: "external", agentId: "codex", name: "Codex" },
      persona: {
        tone: "dry",
        personality: "exacting",
        openingMessage: "Hi",
        exemplarPrompts: ["a", "b"],
      },
      availableOnPlatforms: ["tauri"],
      providerId: "openrouter",
    })
  })

  it("opens a partial draft like a blank agent with only what it names filled in", () => {
    const state = characterToEditorState({ name: "Draft", skillIds: ["sk-1"] })
    expect(state.name).toBe("Draft")
    expect(state.skillIds).toEqual(["sk-1"])
    expect(state.systemPrompt).toBe("")
    expect(state.avatarColor).toBe(AGENT_AVATAR_COLORS[0])
    expect(state.memoryReadableScopes).toEqual(["global", "workspace", "character", "agent"])
    expect(state.runtime).toBeUndefined()
  })

  it("starts a new agent with the sparkle avatar and nothing else chosen", () => {
    const state = emptyEditorState()
    expect(state.avatarEmoji).toBe("✨")
    expect(state.name).toBe("")
    expect(state.voiceProvider).toBe("none")
  })

  it("writes runtime even when cleared, so the app default replaces a stored one", () => {
    const out = editorStateToOutput({ ...characterToEditorState(stored), runtime: undefined })
    expect(out).toHaveProperty("runtime", undefined)
  })

  it("drops blank optional text and keeps an empty plugin-skill list", () => {
    const out = editorStateToOutput({
      ...emptyEditorState(),
      name: "  Named  ",
      description: "   ",
      systemPrompt: "x",
    })
    expect(out.name).toBe("Named")
    expect(out.description).toBeUndefined()
    expect(out.modelRouting).toBeUndefined()
    expect(out.executionPolicy).toBeUndefined()
    expect(out.pluginSkillIds).toEqual([])
    expect(out.computerUseTarget).toBeUndefined()
  })
})

describe("validateEditorState", () => {
  const valid = { ...emptyEditorState(), name: "A", systemPrompt: "B" }

  it("accepts a named agent with instructions", () => {
    expect(validateEditorState(valid)).toBeNull()
  })

  it("reports the first problem in the order a person fixes them", () => {
    expect(validateEditorState({ ...valid, name: " ", systemPrompt: "" })).toEqual({
      code: "nameRequired",
    })
    expect(validateEditorState({ ...valid, systemPrompt: "  " })).toEqual({
      code: "systemPromptRequired",
    })
    expect(validateEditorState({ ...valid, executionMaxTurns: "0" })).toEqual({
      code: "maxTurnsInvalid",
    })
    expect(validateEditorState({ ...valid, executionMaxTurns: "2.5" })).toEqual({
      code: "maxTurnsInvalid",
    })
    expect(
      validateEditorState({
        ...valid,
        executionEnvBindings: [{ name: "1BAD", kind: "plain", value: "" }],
      })
    ).toEqual({ code: "envNameInvalid", name: "1BAD" })
    expect(
      validateEditorState({
        ...valid,
        executionEnvBindings: [
          { name: "TOKEN", kind: "plain", value: "a" },
          { name: " TOKEN ", kind: "plain", value: "b" },
        ],
      })
    ).toEqual({ code: "envNameDuplicate", name: "TOKEN" })
  })
})

describe("helpers", () => {
  it("trims environment names as they are saved", () => {
    expect(
      normalizedEnvBindings({
        ...emptyEditorState(),
        executionEnvBindings: [{ name: " TOKEN ", kind: "plain", value: "v" }],
      })
    ).toEqual([{ name: "TOKEN", kind: "plain", value: "v" }])
  })

  it("splits a typed tool list on commas and newlines", () => {
    expect(parseToolChips("Read, Grep\nBash ,, ")).toEqual(["Read", "Grep", "Bash"])
  })
})
