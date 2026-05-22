/**
 * defineCharacterPack SDK helper tests (ADR-0030 + v2).
 */

import {
  defineCharacterPack,
  PLUGIN_CHARACTER_AVATAR_WEB_DATA_URL_SOFT_BYTES,
  PLUGIN_CHARACTER_PACK_SOFT_LIMIT,
} from "./define-character-pack"
import type { PluginCharacterDef } from "@/types/plugin/plugin-character-pack"

function makeCharacter(overrides: Partial<PluginCharacterDef> = {}): PluginCharacterDef {
  return {
    localId: "alice",
    name: "Alice",
    avatarColor: "oklch(0.7 0.15 250)",
    systemPrompt: "Hello",
    ...overrides,
  }
}

describe("defineCharacterPack", () => {
  it("returns the def unchanged for a valid pack", () => {
    const def = defineCharacterPack({
      id: "demo",
      name: "Demo",
      version: "1.0.0",
      characters: [makeCharacter()],
    })
    expect(def.id).toBe("demo")
    expect(def.characters).toHaveLength(1)
  })

  it("throws when characters is empty", () => {
    expect(() =>
      defineCharacterPack({ id: "empty", name: "Empty", version: "1.0.0", characters: [] })
    ).toThrow(/at least one character/)
  })

  it("throws when characters exceeds the soft limit", () => {
    const too_many = Array.from({ length: PLUGIN_CHARACTER_PACK_SOFT_LIMIT + 1 }, (_, i) =>
      makeCharacter({ localId: `c-${i}` })
    )
    expect(() =>
      defineCharacterPack({ id: "big", name: "Big", version: "1.0.0", characters: too_many })
    ).toThrow(/soft limit/)
  })

  it("throws on duplicate localId", () => {
    expect(() =>
      defineCharacterPack({
        id: "dup",
        name: "Dup",
        version: "1.0.0",
        characters: [makeCharacter(), makeCharacter()],
      })
    ).toThrow(/duplicate localId/)
  })

  it("warns (but does not throw) on unknown voiceProfile.provider", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const def = defineCharacterPack({
        id: "demo",
        name: "Demo",
        version: "1.0.0",
        characters: [
          makeCharacter({
            voiceProfile: {
              provider: "wat" as unknown as "openai",
              voiceId: "x",
            },
          }),
        ],
      })
      expect(def).toBeDefined()
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/voiceProfile\.provider "wat"/))
    } finally {
      warn.mockRestore()
    }
  })

  it("does not warn on a known voiceProfile.provider", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    try {
      defineCharacterPack({
        id: "demo",
        name: "Demo",
        version: "1.0.0",
        characters: [makeCharacter({ voiceProfile: { provider: "openai", voiceId: "alloy" } })],
      })
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it("warns when avatarImage.webDataUrl exceeds the soft byte limit", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const oversize = "A".repeat(PLUGIN_CHARACTER_AVATAR_WEB_DATA_URL_SOFT_BYTES + 1)
      defineCharacterPack({
        id: "demo",
        name: "Demo",
        version: "1.0.0",
        characters: [
          makeCharacter({
            avatarImage: { webDataUrl: `data:image/png;base64,${oversize}` },
          }),
        ],
      })
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/avatarImage\.webDataUrl/))
    } finally {
      warn.mockRestore()
    }
  })

  it("does not warn when avatarImage.webDataUrl is under the limit", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    try {
      defineCharacterPack({
        id: "demo",
        name: "Demo",
        version: "1.0.0",
        characters: [makeCharacter({ avatarImage: { webDataUrl: "data:image/png;base64,small" } })],
      })
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})
