// Mock Dexie + Tauri before importing so the bridge can be exercised as a
// pure function. Plugin overlay imports are real — they only touch an
// in-memory map.

jest.mock("@/lib/db/skills", () => ({
  listEnabledSkillsByIds: jest.fn(),
}))

jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(() => false),
}))

import { listEnabledSkillsByIds } from "@/lib/db/skills"
import { __resetSkillsForTesting, registerSkill } from "@/lib/plugin/registries/skill-registry"
import type { Skill } from "@cognia/agent-config-types"
import type { PluginSkillDef } from "@/types/plugin/plugin-skill"

import {
  extractContainerSkillIds,
  renderResolvedSkillsSection,
  resolveSkillsForCharacter,
} from "./skills-bridge"

const mListSkills = listEnabledSkillsByIds as jest.Mock

function makeChatSkill(p: Partial<Skill> & { id: string }): Skill {
  return {
    name: `Chat ${p.id}`,
    description: "",
    content: `chat body ${p.id}`,
    createdAt: 0,
    updatedAt: 0,
    ...p,
  } as Skill
}

function makePluginSkill(id: string, overrides: Partial<PluginSkillDef> = {}): PluginSkillDef {
  return {
    id,
    name: `Plugin ${id}`,
    description: `desc ${id}`,
    source: { kind: "inline", markdown: `plugin body ${id}` },
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  __resetSkillsForTesting()
  mListSkills.mockResolvedValue([])
})

describe("resolveSkillsForCharacter", () => {
  it("returns an empty array for no ids", async () => {
    const result = await resolveSkillsForCharacter([])
    expect(result).toEqual([])
    expect(mListSkills).not.toHaveBeenCalled()
  })

  it("resolves only chat skills when no plugin entries match", async () => {
    mListSkills.mockResolvedValue([
      makeChatSkill({ id: "s1", content: "hello" }),
      makeChatSkill({ id: "s2", content: "world" }),
    ])

    const result = await resolveSkillsForCharacter(["s1", "s2"])
    expect(mListSkills).toHaveBeenCalledWith(["s1", "s2"])
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({
      id: "s1",
      source: "chat",
      body: "hello",
    })
    expect(result[1]).toMatchObject({
      id: "s2",
      source: "chat",
      body: "world",
    })
  })

  it("resolves only plugin skills when no chat ids remain", async () => {
    registerSkill(
      "anthropic.code-review",
      makePluginSkill("anthropic.code-review", {
        source: { kind: "inline", markdown: "# CR body" },
      }),
      { pluginId: "anthropic-skills" }
    )

    const result = await resolveSkillsForCharacter(["anthropic.code-review"])
    expect(mListSkills).not.toHaveBeenCalled()
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      id: "anthropic.code-review",
      source: "plugin",
      pluginId: "anthropic-skills",
      body: "# CR body",
    })
    expect(result[0].containerSkillId).toBeUndefined()
  })

  it("plugin entry wins on id collision with a chat skill", async () => {
    registerSkill(
      "collision",
      makePluginSkill("collision", {
        source: { kind: "inline", markdown: "from plugin" },
      }),
      { pluginId: "p" }
    )
    // listEnabledSkillsByIds should only be asked for ids the overlay did
    // NOT serve. We assert the bridge never asks for "collision".
    mListSkills.mockImplementation(async (ids: string[]) => {
      expect(ids).not.toContain("collision")
      return []
    })

    const result = await resolveSkillsForCharacter(["collision"])
    expect(result).toHaveLength(1)
    expect(result[0].source).toBe("plugin")
    expect(result[0].body).toBe("from plugin")
  })

  it("mixes chat + plugin entries in the input order, plugins first", async () => {
    registerSkill("p1", makePluginSkill("p1", { source: { kind: "inline", markdown: "p body" } }), {
      pluginId: "plug",
    })
    mListSkills.mockResolvedValue([makeChatSkill({ id: "c1", content: "c body" })])

    const result = await resolveSkillsForCharacter(["p1", "c1"])
    expect(result).toHaveLength(2)
    // Plugin entries are resolved in the iteration order; chat entries follow.
    expect(result.map((r) => r.id)).toEqual(["p1", "c1"])
    expect(result[0].source).toBe("plugin")
    expect(result[1].source).toBe("chat")
  })

  it("anthropic-managed plugin skill returns containerSkillId and no body", async () => {
    registerSkill(
      "managed",
      makePluginSkill("managed", {
        source: {
          kind: "anthropic-managed",
          containerSkillId: "container-1",
          version: "1.0.0",
        },
      })
    )

    const result = await resolveSkillsForCharacter(["managed"])
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      id: "managed",
      source: "plugin",
      containerSkillId: "container-1",
      containerSkillVersion: "1.0.0",
    })
    expect(result[0].body).toBeUndefined()
  })
})

describe("extractContainerSkillIds", () => {
  it("returns an empty list when no resolved skill is anthropic-managed", () => {
    expect(extractContainerSkillIds([])).toEqual([])
    expect(
      extractContainerSkillIds([
        {
          id: "s1",
          name: "S1",
          description: "",
          source: "chat",
          body: "body",
        },
      ])
    ).toEqual([])
  })

  it("extracts skill_id + version pairs only for anthropic-managed entries", () => {
    const result = extractContainerSkillIds([
      {
        id: "managed-a",
        name: "A",
        description: "",
        source: "plugin",
        containerSkillId: "container-a",
        containerSkillVersion: "1.2.3",
      },
      {
        id: "inline-b",
        name: "B",
        description: "",
        source: "plugin",
        body: "body",
      },
      {
        id: "managed-b",
        name: "B",
        description: "",
        source: "plugin",
        containerSkillId: "container-b",
      },
    ])

    expect(result).toEqual([
      { skill_id: "container-a", version: "1.2.3" },
      { skill_id: "container-b", version: undefined },
    ])
  })
})

describe("renderResolvedSkillsSection", () => {
  it("returns an empty string when nothing has a body", () => {
    expect(renderResolvedSkillsSection([])).toBe("")
    expect(
      renderResolvedSkillsSection([
        {
          id: "managed",
          name: "Managed",
          description: "",
          source: "plugin",
          containerSkillId: "c1",
        },
      ])
    ).toBe("")
  })

  it("renders bodies as `## Skill: <name>` blocks joined by separators", () => {
    const section = renderResolvedSkillsSection([
      {
        id: "s1",
        name: "First",
        description: "",
        source: "chat",
        body: "Body one.",
      },
      {
        id: "s2",
        name: "Second",
        description: "",
        source: "plugin",
        body: "Body two.",
      },
      // anthropic-managed entries are skipped — no body
      {
        id: "managed",
        name: "Managed",
        description: "",
        source: "plugin",
        containerSkillId: "container-1",
      },
    ])

    expect(section).toContain("## Skill: First\n\nBody one.")
    expect(section).toContain("## Skill: Second\n\nBody two.")
    expect(section).toContain("\n\n---\n\n")
    expect(section).not.toContain("Managed")
  })

  it("filters out empty-body entries", () => {
    const section = renderResolvedSkillsSection([
      {
        id: "s1",
        name: "Empty",
        description: "",
        source: "chat",
        body: "   ",
      },
      {
        id: "s2",
        name: "Real",
        description: "",
        source: "chat",
        body: "real body",
      },
    ])
    expect(section).toBe("## Skill: Real\n\nreal body")
  })
})
