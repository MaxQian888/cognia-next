// ADR-0030 — Pack requires validation tests. Each test starts with all
// three sibling overlay registries cleared so the available-id sets are
// deterministic.

import { validatePackRequires } from "./validate-requires"
import { __resetSkillsForTesting, registerSkill } from "@/lib/plugin/registries/skill-registry"
import {
  __resetMcpServerPresetsForTesting,
  registerMcpServerPreset,
} from "@/lib/plugin/registries/mcp-server-preset-registry"
import { __resetNativeAnthropicToolsForTesting } from "@/lib/plugin/registries/native-anthropic-tool-registry"
import type { PluginCharacterPackDef } from "@/types/plugin/plugin-character-pack"

function makePack(overrides: Partial<PluginCharacterPackDef> = {}): PluginCharacterPackDef {
  return {
    id: "p",
    name: "P",
    version: "1.0.0",
    characters: [{ localId: "a", name: "A", avatarColor: "x", systemPrompt: "x" }],
    ...overrides,
  }
}

beforeEach(() => {
  __resetSkillsForTesting()
  __resetMcpServerPresetsForTesting()
  __resetNativeAnthropicToolsForTesting()
})

describe("validatePackRequires", () => {
  it("returns ok when no requires block is present", () => {
    const result = validatePackRequires(makePack())
    expect(result.ok).toBe(true)
    expect(result.warnings).toEqual([])
  })

  it("flags missing skill ids declared in requires.skills", () => {
    const result = validatePackRequires(makePack({ requires: { skills: ["foo"] } }))
    expect(result.ok).toBe(false)
    expect(result.warnings).toContainEqual({ code: "missing-skill", missingId: "foo" })
  })

  it("clears the warning once the skill registers", () => {
    registerSkill("foo", {
      id: "foo",
      name: "Foo",
      description: "x",
      source: { kind: "inline", markdown: "x" },
    })
    const result = validatePackRequires(makePack({ requires: { skills: ["foo"] } }))
    expect(result.ok).toBe(true)
  })

  it("flags missing mcp-server-presets", () => {
    const result = validatePackRequires(makePack({ requires: { mcpServerPresets: ["m1", "m2"] } }))
    expect(result.warnings.map((w) => w.missingId)).toEqual(["m1", "m2"])
  })

  it("clears the warning once an mcp preset registers", () => {
    registerMcpServerPreset("m1", {
      id: "m1",
      name: "M1",
      server: { command: "echo", args: [] },
    } as unknown as never)
    const result = validatePackRequires(makePack({ requires: { mcpServerPresets: ["m1"] } }))
    expect(result.ok).toBe(true)
  })

  it("flags missing native-anthropic-tools", () => {
    const result = validatePackRequires(makePack({ requires: { nativeAnthropicTools: ["t1"] } }))
    expect(result.warnings).toContainEqual({ code: "missing-native-tool", missingId: "t1" })
  })

  it("flags missing pluginSkillIds on individual characters", () => {
    const result = validatePackRequires(
      makePack({
        characters: [
          {
            localId: "a",
            name: "A",
            avatarColor: "x",
            systemPrompt: "x",
            pluginSkillIds: ["plugin-skill-a"],
          },
          {
            localId: "b",
            name: "B",
            avatarColor: "x",
            systemPrompt: "x",
            pluginSkillIds: ["plugin-skill-a", "plugin-skill-b"],
          },
        ],
      })
    )
    expect(result.warnings.filter((w) => w.code === "missing-plugin-skill")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ missingId: "plugin-skill-a", characterLocalId: "a" }),
        expect.objectContaining({ missingId: "plugin-skill-a", characterLocalId: "b" }),
        expect.objectContaining({ missingId: "plugin-skill-b", characterLocalId: "b" }),
      ])
    )
  })

  it("tolerates packs without a characters array (defensive stub-entry path)", () => {
    // capability-bridge round-trip test passes a bare `{ id }` entry; the
    // validator must not throw.
    expect(() =>
      validatePackRequires({ id: "stub" } as unknown as PluginCharacterPackDef)
    ).not.toThrow()
  })
})
