/**
 * The built-in pack's authored definitions: seven personas that mirror the
 * legacy-id map the Dexie upgrade and `seedBuiltInCharacters` consume.
 */

import { parseLocalPackFile, serializeLocalPackFile } from "@cognia/plugin-sdk"
import { BUILTIN_LEGACY_ID_TO_LOCAL_ID, BUILTIN_PACK } from "./characters"

describe("built-in character definitions", () => {
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

  it("BUILTIN_PACK round-trips through the canonical pack-file format", () => {
    const body = serializeLocalPackFile(BUILTIN_PACK)
    const parsed = parseLocalPackFile(JSON.parse(body))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.file.pack.id).toBe(BUILTIN_PACK.id)
      expect(parsed.file.pack.characters).toHaveLength(7)
    }
  })
})
