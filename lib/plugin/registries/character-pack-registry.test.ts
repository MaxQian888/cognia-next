/**
 * Character Pack Registry tests (ADR-0030). Mirrors `skill-registry.test.ts`
 * conventions: every test starts from `__resetCharacterPacksForTesting()`,
 * tests are organised around the public surface of
 * `character-pack-registry.ts`.
 */

import type {
  PluginCharacterDef,
  PluginCharacterPackDef,
} from "@/types/plugin/plugin-character-pack"
import {
  __resetCharacterPacksForTesting,
  buildOverlayCharacterId,
  getCharacterPack,
  getCharacterPackEntry,
  getPackCharacterByRuntimeId,
  getPackCharacterWarnings,
  getPackWarnings,
  isOverlayCharacterId,
  listAllPackCharacters,
  listCharacterPackEntries,
  listCharacterPackIds,
  refreshAllPackWarnings,
  registerCharacterPack,
  unregisterCharacterPackById,
  unregisterCharacterPacksByPlugin,
} from "./character-pack-registry"
import { __resetSkillsForTesting, registerSkill } from "./skill-registry"

function makeCharacter(
  localId: string,
  overrides: Partial<PluginCharacterDef> = {}
): PluginCharacterDef {
  return {
    localId,
    name: `Character ${localId}`,
    avatarColor: "oklch(0.7 0.15 250)",
    systemPrompt: `Test prompt for ${localId}`,
    ...overrides,
  }
}

function makePack(
  id: string,
  characters: PluginCharacterDef[],
  overrides: Partial<PluginCharacterPackDef> = {}
): PluginCharacterPackDef {
  return {
    id,
    name: `Pack ${id}`,
    version: "1.0.0",
    characters,
    ...overrides,
  }
}

describe("character-pack-registry", () => {
  beforeEach(() => {
    __resetCharacterPacksForTesting()
    __resetSkillsForTesting()
  })

  it("registers a pack and retrieves it via get / getEntry / list", () => {
    const pack = makePack("workplace", [makeCharacter("alice"), makeCharacter("bob")])
    const previous = registerCharacterPack("workplace", pack, { pluginId: "plug-a" })
    expect(previous).toBeUndefined()

    expect(getCharacterPack("workplace")).toBe(pack)
    expect(getCharacterPackEntry("workplace")).toEqual({
      entry: pack,
      pluginId: "plug-a",
    })
    expect(listCharacterPackIds()).toEqual(["workplace"])
    expect(listCharacterPackEntries()).toEqual([
      { id: "workplace", entry: pack, pluginId: "plug-a" },
    ])
  })

  it("unregisterByPlugin drops every pack from the given pluginId", () => {
    registerCharacterPack("a", makePack("a", [makeCharacter("x")]), { pluginId: "plug" })
    registerCharacterPack("b", makePack("b", [makeCharacter("y")]), { pluginId: "plug" })

    const removed = unregisterCharacterPacksByPlugin("plug")
    expect(removed).toBe(2)
    expect(getCharacterPack("a")).toBeUndefined()
    expect(getCharacterPack("b")).toBeUndefined()
    expect(listCharacterPackIds()).toEqual([])
  })

  it("unregisterByPlugin leaves entries from other plugins alone", () => {
    const a = makePack("a", [makeCharacter("x")])
    const b = makePack("b", [makeCharacter("y")])
    registerCharacterPack("a", a, { pluginId: "pluginA" })
    registerCharacterPack("b", b, { pluginId: "pluginB" })

    const removed = unregisterCharacterPacksByPlugin("pluginA")
    expect(removed).toBe(1)
    expect(getCharacterPack("a")).toBeUndefined()
    expect(getCharacterPack("b")).toBe(b)
  })

  it("unregisterById removes only the matching entry", () => {
    registerCharacterPack("a", makePack("a", [makeCharacter("x")]))
    registerCharacterPack("b", makePack("b", [makeCharacter("y")]))

    expect(unregisterCharacterPackById("a")).toBe(true)
    expect(getCharacterPack("a")).toBeUndefined()
    expect(getCharacterPack("b")).toBeDefined()

    expect(unregisterCharacterPackById("a")).toBe(false)
  })

  it("listAllPackCharacters flattens every contributed character across packs", () => {
    const alice = makeCharacter("alice")
    const bob = makeCharacter("bob")
    const carol = makeCharacter("carol")
    registerCharacterPack("workplace", makePack("workplace", [alice, bob]), { pluginId: "plug-a" })
    registerCharacterPack("study", makePack("study", [carol]), { pluginId: "plug-b" })

    const all = listAllPackCharacters()
    expect(all).toHaveLength(3)
    expect(all.map((e) => e.character.localId)).toEqual(["alice", "bob", "carol"])
    expect(all.map((e) => e.pluginId)).toEqual(["plug-a", "plug-a", "plug-b"])
  })

  it("buildOverlayCharacterId produces the canonical synthetic id format", () => {
    expect(buildOverlayCharacterId("plug-a", "workplace", "alice")).toBe(
      "cognia-pack:plug-a:workplace:alice"
    )
    // Anonymous (local-pack-store-style) registration leaves the plugin segment empty.
    expect(buildOverlayCharacterId(undefined, "imported", "carol")).toBe(
      "cognia-pack::imported:carol"
    )
  })

  it("isOverlayCharacterId discriminates Dexie ids from synthetic overlay ids", () => {
    expect(isOverlayCharacterId("cognia-pack:plug-a:workplace:alice")).toBe(true)
    expect(isOverlayCharacterId("char_builtin_coding")).toBe(false)
    expect(isOverlayCharacterId("char_abc_def")).toBe(false)
    expect(isOverlayCharacterId("")).toBe(false)
  })

  it("getPackCharacterByRuntimeId resolves a registered overlay character", () => {
    const alice = makeCharacter("alice")
    const pack = makePack("workplace", [alice])
    registerCharacterPack("workplace", pack, { pluginId: "plug-a" })

    const resolved = getPackCharacterByRuntimeId("cognia-pack:plug-a:workplace:alice")
    expect(resolved).toBeDefined()
    expect(resolved?.character).toBe(alice)
    expect(resolved?.pack).toBe(pack)
    expect(resolved?.pluginId).toBe("plug-a")
  })

  it("getPackCharacterByRuntimeId returns undefined for unknown plugin / pack / local id", () => {
    registerCharacterPack("workplace", makePack("workplace", [makeCharacter("alice")]), {
      pluginId: "plug-a",
    })

    // Wrong plugin segment.
    expect(getPackCharacterByRuntimeId("cognia-pack:plug-b:workplace:alice")).toBeUndefined()
    // Wrong pack id.
    expect(getPackCharacterByRuntimeId("cognia-pack:plug-a:study:alice")).toBeUndefined()
    // Wrong localId.
    expect(getPackCharacterByRuntimeId("cognia-pack:plug-a:workplace:zoe")).toBeUndefined()
    // Not a synthetic id at all.
    expect(getPackCharacterByRuntimeId("char_builtin_coding")).toBeUndefined()
    // Malformed (missing segments).
    expect(getPackCharacterByRuntimeId("cognia-pack:onlyone")).toBeUndefined()
    expect(getPackCharacterByRuntimeId("cognia-pack:")).toBeUndefined()
    expect(getPackCharacterByRuntimeId("cognia-pack:plug-a:")).toBeUndefined()
  })

  it("getPackCharacterByRuntimeId resolves anonymous packs registered without a pluginId", () => {
    const alice = makeCharacter("alice")
    registerCharacterPack("imported", makePack("imported", [alice]))
    // Anonymous packs use an empty plugin segment.
    const resolved = getPackCharacterByRuntimeId("cognia-pack::imported:alice")
    expect(resolved?.character).toBe(alice)
    expect(resolved?.pluginId).toBeUndefined()
  })

  it("getPackCharacterByRuntimeId tolerates localIds containing colons", () => {
    const exotic = makeCharacter("namespace:weird-id")
    registerCharacterPack("workplace", makePack("workplace", [exotic]), { pluginId: "plug-a" })
    const resolved = getPackCharacterByRuntimeId("cognia-pack:plug-a:workplace:namespace:weird-id")
    expect(resolved?.character).toBe(exotic)
  })

  it("__resetCharacterPacksForTesting clears every registered pack", () => {
    registerCharacterPack("a", makePack("a", [makeCharacter("x")]), { pluginId: "p1" })
    registerCharacterPack("b", makePack("b", [makeCharacter("y")]), { pluginId: "p2" })
    registerCharacterPack("c", makePack("c", [makeCharacter("z")])) // anonymous

    __resetCharacterPacksForTesting()

    expect(listCharacterPackIds()).toEqual([])
    expect(listAllPackCharacters()).toEqual([])
  })

  describe("requires-validation warnings", () => {
    it("stamps warnings on register for missing skill ids", () => {
      registerCharacterPack(
        "workplace",
        makePack("workplace", [makeCharacter("alice")], {
          requires: { skills: ["missing-skill"] },
        }),
        { pluginId: "plug-a" }
      )
      const warnings = getPackWarnings("workplace")
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toEqual({ code: "missing-skill", missingId: "missing-skill" })
    })

    it("returns empty warnings for packs with no requires misses", () => {
      registerCharacterPack("clean", makePack("clean", [makeCharacter("alice")]), {
        pluginId: "plug-a",
      })
      expect(getPackWarnings("clean")).toEqual([])
    })

    it("refreshAllPackWarnings clears warnings once the missing dep registers", () => {
      registerCharacterPack(
        "workplace",
        makePack("workplace", [makeCharacter("alice")], {
          requires: { skills: ["delayed-skill"] },
        }),
        { pluginId: "plug-a" }
      )
      expect(getPackWarnings("workplace")).toHaveLength(1)

      registerSkill("delayed-skill", {
        id: "delayed-skill",
        name: "Delayed",
        description: "x",
        source: { kind: "inline", markdown: "x" },
      })
      refreshAllPackWarnings()
      expect(getPackWarnings("workplace")).toEqual([])
    })

    it("unregister drops the pack's warnings", () => {
      registerCharacterPack(
        "workplace",
        makePack("workplace", [makeCharacter("alice")], {
          requires: { skills: ["missing"] },
        }),
        { pluginId: "plug-a" }
      )
      expect(getPackWarnings("workplace")).toHaveLength(1)
      unregisterCharacterPackById("workplace")
      expect(getPackWarnings("workplace")).toEqual([])
    })

    it("unregisterByPlugin drops warnings for every pack the plugin contributed", () => {
      registerCharacterPack(
        "a",
        makePack("a", [makeCharacter("x")], { requires: { skills: ["missing-a"] } }),
        { pluginId: "plug-a" }
      )
      registerCharacterPack(
        "b",
        makePack("b", [makeCharacter("y")], { requires: { skills: ["missing-b"] } }),
        { pluginId: "plug-a" }
      )
      registerCharacterPack(
        "c",
        makePack("c", [makeCharacter("z")], { requires: { skills: ["missing-c"] } }),
        { pluginId: "plug-b" }
      )

      unregisterCharacterPacksByPlugin("plug-a")
      expect(getPackWarnings("a")).toEqual([])
      expect(getPackWarnings("b")).toEqual([])
      // plug-b's pack warnings stay intact.
      expect(getPackWarnings("c")).toHaveLength(1)
    })

    it("getPackCharacterWarnings filters to a specific character within the pack", () => {
      registerCharacterPack(
        "workplace",
        makePack("workplace", [
          makeCharacter("alice", { pluginSkillIds: ["missing-a"] }),
          makeCharacter("bob", { pluginSkillIds: ["missing-b"] }),
        ]),
        { pluginId: "plug-a" }
      )
      const aliceWarnings = getPackCharacterWarnings("workplace", "alice")
      expect(aliceWarnings.map((w) => w.missingId)).toEqual(["missing-a"])
      const bobWarnings = getPackCharacterWarnings("workplace", "bob")
      expect(bobWarnings.map((w) => w.missingId)).toEqual(["missing-b"])
    })

    it("getPackCharacterWarnings includes pack-level warnings (no character target)", () => {
      registerCharacterPack(
        "workplace",
        makePack("workplace", [makeCharacter("alice")], {
          requires: { mcpServerPresets: ["missing-mcp"] },
        }),
        { pluginId: "plug-a" }
      )
      const aliceWarnings = getPackCharacterWarnings("workplace", "alice")
      expect(aliceWarnings.map((w) => w.code)).toContain("missing-mcp-preset")
    })
  })
})
