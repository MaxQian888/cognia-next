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
import {
  getCharacterPackRegistryVersion,
  getPackTrust,
  registerCharacterPackWithTrust,
  subscribeCharacterPackRegistry,
} from "./character-pack-registry"

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

describe("trust sidecar + subscription (Epic 3)", () => {
  const pack = (id = "p1") =>
    ({ id, name: "P", version: "1.0.0", characters: [] }) as unknown as PluginCharacterPackDef

  const verifiedTrust = {
    state: "verified" as const,
    algo: "ed25519" as const,
    publicKey: "PK",
    fingerprint: "f".repeat(64),
    shortFingerprint: "ed25519:ffff",
    signature: { algo: "ed25519" as const, pubKey: "PK", sig: "SIG" },
  }

  afterEach(() => {
    __resetCharacterPacksForTesting()
  })

  it("defaults every pack to unsigned", () => {
    registerCharacterPack("p1", pack())
    expect(getPackTrust("p1")).toEqual({ state: "unsigned" })
  })

  it("reports unsigned for a pack that was never registered", () => {
    expect(getPackTrust("ghost")).toEqual({ state: "unsigned" })
  })

  it("records a verified trust state through the host-only entry point", () => {
    registerCharacterPackWithTrust("p1", pack(), { trust: verifiedTrust })
    expect(getPackTrust("p1")).toEqual(verifiedTrust)
  })

  it("downgrades to unsigned when a plugin re-registers over a verified pack id", () => {
    // The trust-spoofing guard: `registerCharacterPack` is SDK-exported, so a
    // plugin claiming a previously-verified id must not inherit its badge.
    registerCharacterPackWithTrust("p1", pack(), { trust: verifiedTrust })
    registerCharacterPack("p1", pack(), { pluginId: "impostor" })
    expect(getPackTrust("p1")).toEqual({ state: "unsigned" })
  })

  it("clears trust on unregister by id", () => {
    registerCharacterPackWithTrust("p1", pack(), { trust: verifiedTrust })
    unregisterCharacterPackById("p1")
    expect(getPackTrust("p1")).toEqual({ state: "unsigned" })
  })

  it("clears trust on unregister by plugin", () => {
    registerCharacterPackWithTrust("p1", pack(), { pluginId: "owner", trust: verifiedTrust })
    unregisterCharacterPacksByPlugin("owner")
    expect(getPackTrust("p1")).toEqual({ state: "unsigned" })
  })

  it("clears trust on test reset so state cannot leak between tests", () => {
    registerCharacterPackWithTrust("p1", pack(), { trust: verifiedTrust })
    __resetCharacterPacksForTesting()
    expect(getPackTrust("p1")).toEqual({ state: "unsigned" })
  })

  it("notifies subscribers on every mutation", () => {
    const listener = jest.fn()
    const unsubscribe = subscribeCharacterPackRegistry(listener)

    registerCharacterPack("p1", pack())
    registerCharacterPackWithTrust("p2", pack("p2"), { trust: verifiedTrust })
    refreshAllPackWarnings()
    unregisterCharacterPackById("p1")

    expect(listener).toHaveBeenCalledTimes(4)
    unsubscribe()
    registerCharacterPack("p3", pack("p3"))
    expect(listener).toHaveBeenCalledTimes(4)
  })

  it("notifies on refreshAllPackWarnings so a cleared warning reaches React", () => {
    // Without this the sidecar warnings map mutates invisibly and a resolved
    // dependency keeps rendering its chip until an unrelated re-render.
    const listener = jest.fn()
    const unsubscribe = subscribeCharacterPackRegistry(listener)
    refreshAllPackWarnings()
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it("exposes a monotonic version suitable as a useSyncExternalStore snapshot", () => {
    const before = getCharacterPackRegistryVersion()
    registerCharacterPack("p1", pack())
    const after = getCharacterPackRegistryVersion()
    expect(after).toBeGreaterThan(before)
    // Stable between mutations — the property that stops React looping.
    expect(getCharacterPackRegistryVersion()).toBe(after)
  })

  it("survives a throwing subscriber without breaking the mutation", () => {
    const bad = jest.fn(() => {
      throw new Error("subscriber exploded")
    })
    const good = jest.fn()
    subscribeCharacterPackRegistry(bad)
    subscribeCharacterPackRegistry(good)

    expect(() => registerCharacterPack("p1", pack())).not.toThrow()
    expect(good).toHaveBeenCalled()
    expect(getCharacterPack("p1")).toBeDefined()
  })
})
