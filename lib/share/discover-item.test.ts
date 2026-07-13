import {
  buildSharedDefinition,
  definitionHasPii,
  isShareableDiscoverItem,
  redactSharedDefinition,
  serializeSharedDefinition,
  type SharedCharacterDef,
  type SharedTeamDef,
  type SharedWorkflowTemplateDef,
} from "./discover-item"
import type { Character, Skill, Team } from "@cognia/agent-config-types"
import type { WorkflowCopilotTemplate } from "@/lib/workflow/copilot-templates"
import type { DiscoverItem } from "@/hooks/discover/use-discover-query"

const character = {
  id: "c1",
  name: "Researcher",
  description: "  Finds things  ",
  avatarColor: "#abc",
  avatarEmoji: "🔎",
  systemPrompt: "You are a careful researcher.",
  model: "claude-opus-4-8",
  accountIdOverride: "acct-secret",
  isBuiltIn: true,
} as unknown as Character

const skill = {
  id: "s1",
  name: "Summarise",
  description: "Condenses text",
  content: "Summarise the input in 3 bullets.",
  tags: ["writing"],
  allowedTools: ["Read"],
  isBuiltIn: false,
} as unknown as Skill

const team = {
  id: "t1",
  name: "Squad",
  description: "A small team",
  avatarColor: "#def",
  orchestration: "supervisor",
  supervisorCharacterId: "c1",
  members: [
    { characterId: "c1", role: "Lead", systemPromptOverride: "Coordinate." },
    { characterId: "c2", modelOverride: "x" },
  ],
  isBuiltIn: false,
  createdAt: 1,
  updatedAt: 2,
} as unknown as Team

const template: WorkflowCopilotTemplate = {
  id: "tpl1",
  label: { en: "Cron report", "zh-CN": "定时报告" },
  description: { en: "Schedules a report", "zh-CN": "安排报告" },
  tags: ["cron"],
  slots: [
    {
      key: "channel",
      type: "string",
      label: { en: "Channel", "zh-CN": "频道" },
      description: { en: "Where to post", "zh-CN": "发布位置" },
      required: true,
    },
  ],
  build: () => ({}) as never,
}

describe("buildSharedDefinition", () => {
  it("sanitizes a character, dropping ids/overrides and trimming description", () => {
    const def = buildSharedDefinition(
      { kind: "character", id: "c1", data: character },
      "en"
    ) as SharedCharacterDef
    expect(def).toEqual({
      kind: "character",
      name: "Researcher",
      description: "Finds things",
      systemPrompt: "You are a careful researcher.",
      model: "claude-opus-4-8",
      avatarEmoji: "🔎",
    })
    expect(JSON.stringify(def)).not.toContain("acct-secret")
  })

  it("sanitizes a skill keeping content/tags/tools", () => {
    const def = buildSharedDefinition({ kind: "skill", id: "s1", data: skill }, "en")
    expect(def).toMatchObject({
      kind: "skill",
      name: "Summarise",
      content: "Summarise the input in 3 bullets.",
      tags: ["writing"],
      allowedTools: ["Read"],
    })
  })

  it("sanitizes a team to a descriptive roster (no characterIds)", () => {
    const def = buildSharedDefinition({ kind: "team", id: "t1", data: team }, "en") as SharedTeamDef
    expect(def.kind).toBe("team")
    expect(def.orchestration).toBe("supervisor")
    expect(def.members).toEqual([
      { role: "Lead", systemPromptOverride: "Coordinate." },
      { role: undefined, systemPromptOverride: undefined },
    ])
    expect(JSON.stringify(def)).not.toContain("c2")
  })

  it("resolves a workflow template to the locale and drops build()", () => {
    const def = buildSharedDefinition(
      { kind: "workflowTemplate", id: "tpl1", data: template },
      "zh-CN"
    ) as SharedWorkflowTemplateDef
    expect(def.name).toBe("定时报告")
    expect(def.description).toBe("安排报告")
    expect(def.slots[0]).toMatchObject({ key: "channel", label: "频道", required: true })
    expect("build" in def).toBe(false)
  })

  it("returns null for non-shareable kinds", () => {
    const pluginItem = {
      kind: "plugin",
      id: "p1",
      data: { id: "p1", name: "P" },
    } as unknown as DiscoverItem
    expect(buildSharedDefinition(pluginItem, "en")).toBeNull()
    expect(isShareableDiscoverItem(pluginItem)).toBe(false)
  })

  it("flags every shareable kind and rejects the rest", () => {
    expect(isShareableDiscoverItem({ kind: "character", id: "c1", data: character })).toBe(true)
    expect(isShareableDiscoverItem({ kind: "skill", id: "s1", data: skill })).toBe(true)
    expect(isShareableDiscoverItem({ kind: "team", id: "t1", data: team })).toBe(true)
    expect(isShareableDiscoverItem({ kind: "workflowTemplate", id: "tpl1", data: template })).toBe(
      true
    )
    expect(
      isShareableDiscoverItem({ kind: "twinSource", id: "x", data: {} } as unknown as DiscoverItem)
    ).toBe(false)
  })

  it("drops empty optional fields to undefined (no description / tags / tools)", () => {
    const bare = {
      id: "s2",
      name: "Bare",
      content: "do thing",
      tags: [],
      allowedTools: [],
    } as unknown as Skill
    const def = buildSharedDefinition({ kind: "skill", id: "s2", data: bare }, "en")
    expect(def).toEqual({
      kind: "skill",
      name: "Bare",
      description: undefined,
      content: "do thing",
      tags: undefined,
      allowedTools: undefined,
    })
  })

  it("falls back to the en label when the requested locale is missing, and a slot has no description", () => {
    const partial = {
      id: "tpl2",
      label: { en: "Only EN" },
      description: { en: "Desc EN" },
      slots: [{ key: "x", type: "string", label: { en: "X" } }],
      build: () => ({}) as never,
    } as unknown as WorkflowCopilotTemplate
    const def = buildSharedDefinition(
      { kind: "workflowTemplate", id: "tpl2", data: partial },
      "zh-CN"
    ) as SharedWorkflowTemplateDef
    expect(def.name).toBe("Only EN")
    expect(def.slots[0]).toEqual({
      key: "x",
      type: "string",
      label: "X",
      description: undefined,
      required: undefined,
      options: undefined,
    })
  })
})

describe("PII gate + redaction", () => {
  it("detects PII in a definition and redacts it while staying valid JSON", () => {
    const leaky: SharedCharacterDef = {
      kind: "character",
      name: "Bot",
      systemPrompt: "Email me at alice@example.com for help.",
    }
    expect(definitionHasPii(leaky)).toBe(true)
    const redacted = redactSharedDefinition(leaky) as SharedCharacterDef
    expect(redacted.systemPrompt).not.toContain("alice@example.com")
    expect(redacted.systemPrompt).toContain("<EMAIL_001>")
    // round-trips back to a valid object
    expect(redacted.kind).toBe("character")
    expect(definitionHasPii(redacted)).toBe(false)
  })

  it("reports no PII for a clean definition", () => {
    const clean: SharedCharacterDef = {
      kind: "character",
      name: "Bot",
      systemPrompt: "Be helpful and concise.",
    }
    expect(definitionHasPii(clean)).toBe(false)
  })

  it("serializes to JSON", () => {
    const def: SharedCharacterDef = { kind: "character", name: "X", systemPrompt: "Y" }
    expect(JSON.parse(serializeSharedDefinition(def))).toEqual(def)
  })
})
