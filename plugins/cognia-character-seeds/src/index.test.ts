/**
 * cognia-character-seeds plugin tests.
 *
 * This plugin is the copy-paste reference for ADR-0030 character packs, so
 * the contract it demonstrates must be one that actually loads for an
 * INSTALLED plugin: packs declared in plugin.json, a module manifest that
 * matches it field for field, and no imperative registration.
 */

import { validatePluginManifest } from "@cognia/plugin-sdk/manifest"
import definition, { manifest } from "./index"
import manifestJson from "../plugin.json"

describe("cognia-character-seeds plugin", () => {
  it("declares the character-pack capability and both demo packs in plugin.json", () => {
    expect(manifestJson.capabilities).toContain("character-pack")
    expect(manifestJson.characterPacks.map((pack) => pack.id).sort()).toEqual([
      "study-buddies",
      "workplace-suite",
    ])
    // Declared in the file, the validator's field-backed capability check is
    // satisfied (no `field_missing:character-pack` warning).
    const result = validatePluginManifest(manifestJson)
    expect(result.errors).toEqual([])
    expect(result.warnings).toEqual([])
  })

  it("keeps the module manifest identical to plugin.json for every contribution", () => {
    // `assertPluginManifestParity` refuses an installed plugin whose module
    // manifest declares contributions its plugin.json lacks — the failure the
    // old TS-only template walked every author into.
    expect(manifest).toEqual(manifestJson)
    expect(definition.manifest).toBe(manifest)
  })

  it("every pack character has the required PluginCharacterDef shape", () => {
    for (const pack of manifestJson.characterPacks) {
      expect(pack.characters.length).toBeGreaterThan(0)
      expect(new Set(pack.characters.map((c) => c.localId)).size).toBe(pack.characters.length)
      for (const c of pack.characters) {
        expect(c.localId).toBeTruthy()
        expect(c.name).toBeTruthy()
        expect(c.avatarColor).toBeTruthy()
        expect(c.systemPrompt.length).toBeGreaterThan(20)
      }
    }
  })

  it("activate() registers nothing — the manager's dispatch owns registration", async () => {
    const register = jest.fn()
    const ctx = { characterPacks: { register } } as unknown as Parameters<
      typeof definition.activate
    >[0]
    await definition.activate(ctx)
    expect(register).not.toHaveBeenCalled()
  })

  it("stays off until the user enables it", () => {
    expect(manifestJson).not.toHaveProperty("activationEvents")
  })
})
