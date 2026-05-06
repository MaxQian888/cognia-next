import type { Character } from "@/lib/claude/types"
import type { CharacterDraft } from "@/lib/db/characters"
import type { SubAgentTemplate } from "@/types/agent/sub-agent"

import type { SubagentImportDraft } from "./types"

// ---- Mocks --------------------------------------------------------------

interface MockStore {
  templates: Record<string, SubAgentTemplate>
  addTemplate: jest.Mock<void, [SubAgentTemplate]>
  updateTemplate: jest.Mock<void, [string, Partial<SubAgentTemplate>]>
  deleteTemplate: jest.Mock<void, [string]>
}

const store: MockStore = {
  templates: {},
  addTemplate: jest.fn((t: SubAgentTemplate) => {
    store.templates[t.id] = t
  }),
  updateTemplate: jest.fn((id: string, patch: Partial<SubAgentTemplate>) => {
    const current = store.templates[id]
    if (!current || current.isBuiltIn) return
    store.templates[id] = { ...current, ...patch }
  }),
  deleteTemplate: jest.fn(),
}

jest.mock("@/stores/agent/subagent-runtime-store", () => ({
  useSubagentRuntimeStore: { getState: () => store },
}))

interface CharacterStore {
  rows: Map<string, Character>
}
const charStore: CharacterStore = { rows: new Map() }

let createCalls = 0
jest.mock("@/lib/db/characters", () => ({
  listCharacters: jest.fn(async () =>
    Array.from(charStore.rows.values()).sort((a, b) => a.name.localeCompare(b.name))
  ),
  createCharacter: jest.fn(async (draft: CharacterDraft) => {
    createCalls += 1
    const id = `char_${createCalls}`
    const now = Date.now()
    const created: Character = {
      id,
      name: draft.name.trim() || "Untitled character",
      description: draft.description,
      avatarColor: draft.avatarColor ?? "oklch(0.7 0.15 250)",
      avatarEmoji: draft.avatarEmoji,
      systemPrompt: draft.systemPrompt,
      model: draft.model,
      permissionMode: draft.permissionMode,
      allowedTools: draft.allowedTools,
      createdAt: now,
      updatedAt: now,
    }
    charStore.rows.set(id, created)
    return created
  }),
  updateCharacter: jest.fn(async (id: string, patch: Partial<Character>) => {
    const cur = charStore.rows.get(id)
    if (!cur) throw new Error(`No character ${id}`)
    charStore.rows.set(id, { ...cur, ...patch, updatedAt: Date.now() })
  }),
}))

// Import AFTER mocks so the module under test picks them up.
import { applySubagentImport } from "./apply"

// ---- Helpers ------------------------------------------------------------

function draft(name: string, partial: Partial<SubagentImportDraft> = {}): SubagentImportDraft {
  return {
    source: "claude-code",
    sourceKey: `claude-code:${name.toLowerCase()}`,
    name,
    description: "desc",
    systemPrompt: "prompt",
    tools: ["Read"],
    model: "sonnet",
    providerHint: "anthropic",
    sourceFile: `.claude/agents/${name}.md`,
    warnings: [],
    ...partial,
  }
}

function tpl(id: string, name: string, isBuiltIn = false): SubAgentTemplate {
  return {
    id,
    name,
    description: "",
    category: "general",
    taskTemplate: "{{task}}",
    config: {},
    isBuiltIn,
  }
}

beforeEach(() => {
  store.templates = {}
  store.addTemplate.mockClear()
  store.updateTemplate.mockClear()
  charStore.rows.clear()
  createCalls = 0
  // Reset character mock counters
  jest.clearAllMocks()
})

// ---- SubAgentTemplate target tests --------------------------------------

describe("applySubagentImport — subagent-template target", () => {
  it("imports a fresh draft", async () => {
    const r = await applySubagentImport({
      drafts: [draft("New Agent")],
      target: "subagent-template",
      strategy: "skip",
    })
    expect(r).toEqual({ imported: 1, skipped: 0, overwritten: 0, failed: [] })
    expect(store.addTemplate).toHaveBeenCalledTimes(1)
  })

  it("skip: existing name is left alone", async () => {
    store.templates["existing"] = tpl("existing", "Same Name")
    const r = await applySubagentImport({
      drafts: [draft("Same Name")],
      target: "subagent-template",
      strategy: "skip",
    })
    expect(r.skipped).toBe(1)
    expect(r.imported).toBe(0)
    expect(store.addTemplate).not.toHaveBeenCalled()
  })

  it("skip: case-insensitive name match", async () => {
    store.templates["existing"] = tpl("existing", "Same Name")
    const r = await applySubagentImport({
      drafts: [draft("SAME name")],
      target: "subagent-template",
      strategy: "skip",
    })
    expect(r.skipped).toBe(1)
  })

  it("overwrite: replaces in place via updateTemplate", async () => {
    store.templates["e1"] = tpl("e1", "Same Name")
    const r = await applySubagentImport({
      drafts: [draft("Same Name", { description: "new desc" })],
      target: "subagent-template",
      strategy: "overwrite",
    })
    expect(r.overwritten).toBe(1)
    expect(store.updateTemplate).toHaveBeenCalledTimes(1)
    expect(store.updateTemplate.mock.calls[0][0]).toBe("e1")
    expect(store.updateTemplate.mock.calls[0][1].description).toBe("new desc")
  })

  it("overwrite: built-in cannot be overwritten — surfaces failed", async () => {
    store.templates["builtin"] = tpl("builtin", "Same Name", true)
    const r = await applySubagentImport({
      drafts: [draft("Same Name")],
      target: "subagent-template",
      strategy: "overwrite",
    })
    expect(r.overwritten).toBe(0)
    expect(r.failed).toHaveLength(1)
    expect(r.failed[0].error).toMatch(/built-in/i)
    expect(store.updateTemplate).not.toHaveBeenCalled()
  })

  it("duplicate: appends ' (2)' suffix", async () => {
    store.templates["e1"] = tpl("e1", "Same Name")
    const r = await applySubagentImport({
      drafts: [draft("Same Name")],
      target: "subagent-template",
      strategy: "duplicate",
    })
    expect(r.imported).toBe(1)
    const added = store.addTemplate.mock.calls[0][0]
    expect(added.name).toBe("Same Name (2)")
  })

  it("duplicate: increments suffix when (2) is also taken", async () => {
    store.templates["e1"] = tpl("e1", "Same Name")
    store.templates["e2"] = tpl("e2", "Same Name (2)")
    const r = await applySubagentImport({
      drafts: [draft("Same Name")],
      target: "subagent-template",
      strategy: "duplicate",
    })
    expect(r.imported).toBe(1)
    expect(store.addTemplate.mock.calls[0][0].name).toBe("Same Name (3)")
  })

  it("captures unexpected errors in failed[]", async () => {
    store.addTemplate.mockImplementationOnce(() => {
      throw new Error("kaboom")
    })
    const r = await applySubagentImport({
      drafts: [draft("X")],
      target: "subagent-template",
      strategy: "skip",
    })
    expect(r.failed).toEqual([{ name: "X", error: "kaboom" }])
  })

  it("processes a mixed batch", async () => {
    store.templates["e1"] = tpl("e1", "Existing")
    const r = await applySubagentImport({
      drafts: [draft("Existing"), draft("New One"), draft("Another")],
      target: "subagent-template",
      strategy: "skip",
    })
    expect(r.imported).toBe(2)
    expect(r.skipped).toBe(1)
  })
})

// ---- Character target tests ---------------------------------------------

describe("applySubagentImport — character target", () => {
  function seedChar(name: string, isBuiltIn = false): Character {
    const id = `seed_${charStore.rows.size + 1}`
    const c: Character = {
      id,
      name,
      avatarColor: "oklch(0.7 0.15 250)",
      systemPrompt: "old prompt",
      isBuiltIn,
      createdAt: 0,
      updatedAt: 0,
    }
    charStore.rows.set(id, c)
    return c
  }

  it("imports a fresh draft", async () => {
    const r = await applySubagentImport({
      drafts: [draft("Char A")],
      target: "character",
      strategy: "skip",
    })
    expect(r.imported).toBe(1)
    expect(charStore.rows.size).toBe(1)
  })

  it("skip: existing name left alone", async () => {
    seedChar("Same")
    const r = await applySubagentImport({
      drafts: [draft("same")],
      target: "character",
      strategy: "skip",
    })
    expect(r.skipped).toBe(1)
    expect(charStore.rows.size).toBe(1)
  })

  it("overwrite: updates in place", async () => {
    const seed = seedChar("Same")
    const r = await applySubagentImport({
      drafts: [draft("Same", { systemPrompt: "new prompt" })],
      target: "character",
      strategy: "overwrite",
    })
    expect(r.overwritten).toBe(1)
    expect(charStore.rows.get(seed.id)?.systemPrompt).toBe("new prompt")
  })

  it("overwrite: built-in cannot be overwritten", async () => {
    seedChar("Builtin", true)
    const r = await applySubagentImport({
      drafts: [draft("Builtin")],
      target: "character",
      strategy: "overwrite",
    })
    expect(r.overwritten).toBe(0)
    expect(r.failed[0].error).toMatch(/built-in/i)
  })

  it("duplicate: suffixes name", async () => {
    seedChar("Same")
    const r = await applySubagentImport({
      drafts: [draft("Same")],
      target: "character",
      strategy: "duplicate",
    })
    expect(r.imported).toBe(1)
    const created = Array.from(charStore.rows.values()).find((c) => c.name === "Same (2)")
    expect(created).toBeDefined()
  })

  it("captures errors from createCharacter", async () => {
    const charactersModule = jest.requireMock("@/lib/db/characters") as {
      createCharacter: jest.Mock
    }
    charactersModule.createCharacter.mockImplementationOnce(() => {
      throw new Error("disk full")
    })
    const r = await applySubagentImport({
      drafts: [draft("X")],
      target: "character",
      strategy: "skip",
    })
    expect(r.failed).toEqual([{ name: "X", error: "disk full" }])
  })
})
