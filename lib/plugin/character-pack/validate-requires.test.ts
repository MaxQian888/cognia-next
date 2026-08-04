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
import {
  __resetThemePackRegistryForTesting,
  registerThemePack,
} from "@/lib/theme/theme-pack-registry"
import {
  __resetKnownConnectorKindsForTesting,
  registerPluginConnectorKind,
  unregisterPluginConnectorKindsByPlugin,
} from "@/lib/connectors/known-kinds"

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

describe("new requires dimensions (Epic 3)", () => {
  const packWith = (requires: Record<string, unknown>) =>
    ({
      id: "p",
      name: "P",
      version: "1.0.0",
      characters: [],
      requires,
    }) as unknown as PluginCharacterPackDef

  describe("themePacks", () => {
    afterEach(() => {
      __resetThemePackRegistryForTesting()
    })

    it("warns for a theme pack that is not registered", () => {
      const { warnings } = validatePackRequires(packWith({ themePacks: ["plug.pack"] }))
      expect(warnings).toEqual([{ code: "missing-theme-pack", missingId: "plug.pack" }])
    })

    it("resolves the canonical `<pluginId>.<packId>` key", () => {
      registerThemePack({ pluginId: "plug", pack: { id: "pack", name: "Pack", applies: {} } })
      const { warnings, ok } = validatePackRequires(packWith({ themePacks: ["plug.pack"] }))
      expect(warnings).toEqual([])
      expect(ok).toBe(true)
    })
  })

  describe("connectors", () => {
    afterEach(() => {
      __resetKnownConnectorKindsForTesting()
    })

    it("resolves a stable built-in kind", () => {
      expect(validatePackRequires(packWith({ connectors: ["telegram"] })).warnings).toEqual([])
    })

    it("warns for a reserved-but-unimplemented kind", () => {
      // `kook` is in the PlatformKind union but has no adapter.
      const { warnings } = validatePackRequires(packWith({ connectors: ["kook"] }))
      expect(warnings).toEqual([{ code: "missing-connector", missingId: "kook" }])
    })

    it("resolves a plugin-registered kind and warns again after removal", () => {
      registerPluginConnectorKind("acme", "acme-chat")
      expect(validatePackRequires(packWith({ connectors: ["acme-chat"] })).warnings).toEqual([])
      unregisterPluginConnectorKindsByPlugin("acme")
      expect(validatePackRequires(packWith({ connectors: ["acme-chat"] })).warnings).toEqual([
        { code: "missing-connector", missingId: "acme-chat" },
      ])
    })
  })

  describe("providers", () => {
    it("resolves a built-in provider id", () => {
      expect(validatePackRequires(packWith({ providers: ["anthropic"] })).warnings).toEqual([])
    })

    it("warns for an unknown provider", () => {
      const { warnings } = validatePackRequires(packWith({ providers: ["nope-ai"] }))
      expect(warnings).toEqual([{ code: "missing-provider", missingId: "nope-ai" }])
    })

    it("warns per-character for a pinned providerId, scoped to that character", () => {
      const pack = {
        id: "p",
        name: "P",
        version: "1.0.0",
        characters: [
          {
            localId: "ok",
            name: "A",
            avatarColor: "#fff",
            systemPrompt: "x",
            providerId: "anthropic",
          },
          {
            localId: "bad",
            name: "B",
            avatarColor: "#fff",
            systemPrompt: "x",
            providerId: "nope-ai",
          },
        ],
      } as unknown as PluginCharacterPackDef
      expect(validatePackRequires(pack).warnings).toEqual([
        { code: "missing-provider", missingId: "nope-ai", characterLocalId: "bad" },
      ])
    })
  })

  it("warns but never blocks — a pack with every dimension missing still validates as a pack", () => {
    const { warnings, ok } = validatePackRequires(
      packWith({ themePacks: ["a.b"], connectors: ["nope"], providers: ["nope"] })
    )
    // Three warnings, and `ok: false` is advisory metadata — the registry
    // ignores it and registers the pack regardless.
    expect(warnings).toHaveLength(3)
    expect(ok).toBe(false)
  })
})
