/**
 * First-party cognia-builtin-characters plugin smoke tests.
 *
 * Pins the contract between the plugin manifest, the BUILTIN_PACK
 * definition, and the legacy-id map consumed by Dexie v50 + the
 * post-boot `seedBuiltInCharacters` adapter. Changing any of these in
 * isolation breaks the migration path.
 */

import { isOverlayCharacterId } from "@cognia/plugin-sdk/api/character-pack"
import { validatePluginManifest } from "@cognia/plugin-sdk/manifest"
import { parseLocalPackFile, serializeLocalPackFile } from "@cognia/plugin-sdk"
import definition, {
  BUILTIN_LEGACY_ID_TO_LOCAL_ID,
  BUILTIN_PACK,
  BUILTIN_PLUGIN_ID,
  manifest,
} from "./index"
import manifestJson from "../plugin.json"

describe("cognia-builtin-characters plugin", () => {
  it("declares the character-pack capability with the expected pluginId", () => {
    expect(BUILTIN_PLUGIN_ID).toBe("cognia-builtin-characters")
    expect(BUILTIN_PACK.id).toBe("builtin")
    expect(BUILTIN_PACK.version).toMatch(/^\d+\.\d+\.\d+/)
  })

  it("ships exactly seven characters that mirror the stable-id map", () => {
    expect(BUILTIN_PACK.characters).toHaveLength(7)
    const localIds = BUILTIN_PACK.characters.map((c) => c.localId).sort()
    const mapLocalIds = Object.values(BUILTIN_LEGACY_ID_TO_LOCAL_ID).sort()
    expect(localIds).toEqual(mapLocalIds)
  })

  it("stable-id map keys cover every canonical built-in row id", () => {
    expect(Object.keys(BUILTIN_LEGACY_ID_TO_LOCAL_ID).sort()).toEqual(
      [
        "char_builtin_brainstorm",
        "char_builtin_coding",
        "char_builtin_goal_tracker",
        "char_builtin_research",
        "char_builtin_support",
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

  it("activate() leaves registration to the manager's declarative dispatch", async () => {
    // The manager registers `manifest.characterPacks` on enable; a second,
    // imperative registration from activate() only overwrote that entry.
    const register = jest.fn()
    const ctx = { characterPacks: { register } } as unknown as Parameters<
      typeof definition.activate
    >[0]
    await definition.activate(ctx)
    expect(register).not.toHaveBeenCalled()
  })

  it("BUILTIN_PACK round-trips through the canonical pack-file format", () => {
    const body = serializeLocalPackFile(BUILTIN_PACK)
    const parsed = parseLocalPackFile(JSON.parse(body))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.file.pack.id).toBe(BUILTIN_PACK.id)
      expect(parsed.file.pack.characters).toHaveLength(7)
    }
  })

  it("synthetic overlay ids for built-ins use the stable namespace", () => {
    for (const c of BUILTIN_PACK.characters) {
      const id = `cognia-pack:${BUILTIN_PLUGIN_ID}:${BUILTIN_PACK.id}:${c.localId}`
      expect(isOverlayCharacterId(id)).toBe(true)
    }
  })

  it("manifest is plugin.json plus the pack, with startup activation", () => {
    expect(definition.manifest).toBe(manifest)
    // Every plugin.json field survives — a hand-written subset used to drop
    // author, license, engines and runtimeCompatibility from the module side.
    expect(manifest).toEqual({ ...manifestJson, characterPacks: [BUILTIN_PACK] })
    expect(manifest.id).toBe(BUILTIN_PLUGIN_ID)
    expect(manifest.capabilities).toContain("character-pack")
    // The default personas must exist without the user opting in.
    expect(manifest.activationEvents).toEqual(["startup"])
    expect(validatePluginManifest(manifest).errors).toEqual([])
  })
})
