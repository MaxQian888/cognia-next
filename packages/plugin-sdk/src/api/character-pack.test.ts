import * as sdk from "./character-pack"

describe("plugin-sdk: api/character-pack", () => {
  it("re-exports the helper + registry functions plugin authors call", () => {
    expect(typeof sdk.defineCharacterPack).toBe("function")
    expect(typeof sdk.PLUGIN_CHARACTER_PACK_SOFT_LIMIT).toBe("number")
    expect(typeof sdk.registerCharacterPack).toBe("function")
    expect(typeof sdk.unregisterCharacterPackById).toBe("function")
    expect(typeof sdk.unregisterCharacterPacksByPlugin).toBe("function")
    expect(typeof sdk.getCharacterPack).toBe("function")
    expect(typeof sdk.getCharacterPackEntry).toBe("function")
    expect(typeof sdk.listCharacterPackIds).toBe("function")
    expect(typeof sdk.listCharacterPackEntries).toBe("function")
    expect(typeof sdk.listAllPackCharacters).toBe("function")
    expect(typeof sdk.getPackCharacterByRuntimeId).toBe("function")
    expect(typeof sdk.buildOverlayCharacterId).toBe("function")
    expect(typeof sdk.isOverlayCharacterId).toBe("function")
    expect(typeof sdk.getPackWarnings).toBe("function")
    expect(typeof sdk.getPackCharacterWarnings).toBe("function")
    expect(typeof sdk.refreshAllPackWarnings).toBe("function")
  })

  it("defineCharacterPack is a typesafe identity function", () => {
    const pack = sdk.defineCharacterPack({
      id: "support-team",
      name: "Support Team",
      version: "1.0.0",
      characters: [
        {
          localId: "triage",
          name: "Triage",
          avatarColor: "oklch(0.7 0.15 250)",
          systemPrompt: "Sort incoming issues.",
        },
      ],
    })

    expect(pack.id).toBe("support-team")
    expect(pack.characters[0]?.localId).toBe("triage")
  })

  it("builds and detects overlay character ids through the public API", () => {
    const runtimeId = sdk.buildOverlayCharacterId("plugin-a", "support-team", "triage")

    expect(runtimeId).toBe("cognia-pack:plugin-a:support-team:triage")
    expect(sdk.isOverlayCharacterId(runtimeId)).toBe(true)
    expect(sdk.isOverlayCharacterId("triage")).toBe(false)
  })
})
