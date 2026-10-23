/**
 * First-party cognia-builtin-characters plugin smoke tests.
 *
 * Pins the contract between the plugin manifest and the BUILTIN_PACK
 * definition. The host seeds the same pack before plugin boot from the
 * generated pre-boot snapshot, so changing either in isolation breaks it.
 */

import { isOverlayCharacterId } from "@cognia/plugin-sdk/api/character-pack"
import { validatePluginManifest } from "@cognia/plugin-sdk/manifest"
import definition, { BUILTIN_PACK, BUILTIN_PLUGIN_ID, manifest } from "./index"
import manifestJson from "../plugin.json"

describe("cognia-builtin-characters plugin", () => {
  it("declares the character-pack capability with the expected pluginId", () => {
    expect(BUILTIN_PLUGIN_ID).toBe("cognia-builtin-characters")
    expect(BUILTIN_PACK.id).toBe("builtin")
    expect(BUILTIN_PACK.version).toMatch(/^\d+\.\d+\.\d+/)
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
