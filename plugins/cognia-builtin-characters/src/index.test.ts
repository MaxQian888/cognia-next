/**
 * First-party cognia-builtin-characters plugin smoke tests.
 *
 * Pins the contract between the plugin manifest, the BUILTIN_PACK
 * definition, and the legacy-id map consumed by Dexie v50 + the
 * post-boot `seedBuiltInCharacters` adapter. Changing any of these in
 * isolation breaks the migration path.
 */

import {
  __resetCharacterPacksForTesting,
  getCharacterPack,
  isOverlayCharacterId,
} from "@/lib/plugin/registries/character-pack-registry"
import { parseLocalPackFile, serializeLocalPackFile } from "@/lib/plugin/character-pack/schema"
import definition, { BUILTIN_LEGACY_ID_TO_LOCAL_ID, BUILTIN_PACK, BUILTIN_PLUGIN_ID } from "./index"

afterEach(() => {
  __resetCharacterPacksForTesting()
})

describe("cognia-builtin-characters plugin", () => {
  it("declares the character-pack capability with the expected pluginId", () => {
    expect(BUILTIN_PLUGIN_ID).toBe("cognia-builtin-characters")
    expect(BUILTIN_PACK.id).toBe("builtin")
    expect(BUILTIN_PACK.version).toMatch(/^\d+\.\d+\.\d+/)
  })

  it("ships exactly six characters that mirror the legacy-id map", () => {
    expect(BUILTIN_PACK.characters).toHaveLength(6)
    const localIds = BUILTIN_PACK.characters.map((c) => c.localId).sort()
    const mapLocalIds = Object.values(BUILTIN_LEGACY_ID_TO_LOCAL_ID).sort()
    expect(localIds).toEqual(mapLocalIds)
  })

  it("legacy-id map keys cover the canonical six built-in row ids", () => {
    expect(Object.keys(BUILTIN_LEGACY_ID_TO_LOCAL_ID).sort()).toEqual(
      [
        "char_builtin_brainstorm",
        "char_builtin_coding",
        "char_builtin_goal_tracker",
        "char_builtin_research",
        "char_builtin_translator",
        "char_builtin_writer",
      ].sort()
    )
  })

  it("each character has the required PluginCharacterDef shape", () => {
    for (const c of BUILTIN_PACK.characters) {
      expect(c.localId).toBeTruthy()
      expect(c.name).toBeTruthy()
      expect(c.avatarColor).toBeTruthy()
      expect(c.systemPrompt.length).toBeGreaterThan(20)
    }
  })

  it("activate() registers BUILTIN_PACK and deactivate() cleans up", async () => {
    const ctx = {
      pluginId: BUILTIN_PLUGIN_ID,
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    } as unknown as Parameters<NonNullable<typeof definition.activate>>[0]
    await definition.activate?.(ctx)
    expect(getCharacterPack(BUILTIN_PACK.id)).toBeDefined()
    await definition.deactivate?.(ctx)
    expect(getCharacterPack(BUILTIN_PACK.id)).toBeUndefined()
  })

  it("BUILTIN_PACK round-trips through the canonical pack-file format", () => {
    const body = serializeLocalPackFile(BUILTIN_PACK)
    const parsed = parseLocalPackFile(JSON.parse(body))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.file.pack.id).toBe(BUILTIN_PACK.id)
      expect(parsed.file.pack.characters).toHaveLength(6)
    }
  })

  it("synthetic overlay ids for built-ins use the stable namespace", () => {
    for (const c of BUILTIN_PACK.characters) {
      const id = `cognia-pack:${BUILTIN_PLUGIN_ID}:${BUILTIN_PACK.id}:${c.localId}`
      expect(isOverlayCharacterId(id)).toBe(true)
    }
  })

  it("manifest declares character-pack capability + startup activation", () => {
    const m = definition.manifest as unknown as Record<string, unknown>
    expect(m.id).toBe(BUILTIN_PLUGIN_ID)
    expect(m.capabilities).toContain("character-pack")
    const packs = m.characterPacks as Array<{ id: string }>
    expect(packs.map((p) => p.id)).toEqual([BUILTIN_PACK.id])
  })
})
