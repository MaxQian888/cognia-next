/**
 * The built-in pack's authored definitions: seven personas whose localIds are
 * stable ids the host maps its legacy `char_builtin_*` rows onto.
 */

import { parseLocalPackFile, serializeLocalPackFile } from "@cognia/plugin-sdk"
import { BUILTIN_PACK } from "./characters"

describe("built-in character definitions", () => {
  it("ships exactly the seven stable localIds", () => {
    // The host pins the same list against its legacy-id map; a rename here
    // orphans user customisations of that persona.
    expect(BUILTIN_PACK.characters.map((c) => c.localId).sort()).toEqual([
      "brainstorm",
      "coding",
      "goal-tracker",
      "research",
      "support",
      "translator",
      "writer",
    ])
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
