/**
 * cognia-character-seeds plugin smoke tests.
 *
 * This plugin is the copy-paste reference for ADR-0030 character packs, so
 * the contract it demonstrates (manifest declarations + imperative
 * activate/deactivate registration for dev hot-reload) must stay correct —
 * authors clone it verbatim.
 */

import definition from "./index"
import type { PluginCharacterPackDef } from "@cognia/plugin-sdk"
function manifestPacks(): PluginCharacterPackDef[] {
  const m = definition.manifest as unknown as { characterPacks?: PluginCharacterPackDef[] }
  return m.characterPacks ?? []
}

describe("cognia-character-seeds plugin", () => {
  it("declares the character-pack capability and two demo packs", () => {
    const m = definition.manifest as unknown as Record<string, unknown>
    expect(m.id).toBe("cognia-character-seeds")
    expect(m.capabilities).toContain("character-pack")
    expect(
      manifestPacks()
        .map((p) => p.id)
        .sort()
    ).toEqual(["study-buddies", "workplace-suite"])
  })

  it("every pack character has the required PluginCharacterDef shape", () => {
    for (const pack of manifestPacks()) {
      expect(pack.characters.length).toBeGreaterThan(0)
      for (const c of pack.characters) {
        expect(c.localId).toBeTruthy()
        expect(c.name).toBeTruthy()
        expect(c.avatarColor).toBeTruthy()
        expect(c.systemPrompt.length).toBeGreaterThan(20)
      }
    }
  })

  it("activate() registers both packs through the scoped context API", async () => {
    const register = jest.fn()
    const ctx = {
      pluginId: "cognia-character-seeds",
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      characterPacks: { register },
    } as unknown as Parameters<NonNullable<typeof definition.activate>>[0]

    await definition.activate?.(ctx)
    expect(register.mock.calls.map(([pack]) => pack.id)).toEqual([
      "workplace-suite",
      "study-buddies",
    ])
  })
})
