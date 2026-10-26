import { isOverlayCharacterId } from "@/lib/plugin/registries/character-pack-registry"
import {
  BUILTIN_CHARACTERS_PLUGIN_ID,
  BUILTIN_CHARACTER_PACK_ID,
  BUILTIN_LEGACY_ID_TO_LOCAL_ID,
  builtinCharacterRuntimeId,
  getBuiltinCharacterPack,
} from "./builtin-character-pack"
import { SUPPORT_AGENT_CANONICAL_ID, SUPPORT_AGENT_ID } from "@/lib/support-agent/context"

describe("built-in character pack (host view)", () => {
  it("reads the shipped pack from the pre-boot snapshot", () => {
    const pack = getBuiltinCharacterPack()
    expect(pack?.id).toBe(BUILTIN_CHARACTER_PACK_ID)
    expect(pack?.version).toMatch(/^\d+\.\d+\.\d+/)
    expect(pack?.characters).toHaveLength(7)
  })

  it("maps every legacy row id to a localId the plugin ships, and back", () => {
    const localIds = getBuiltinCharacterPack()!
      .characters.map((c) => c.localId)
      .sort()
    expect(Object.values(BUILTIN_LEGACY_ID_TO_LOCAL_ID).sort()).toEqual(localIds)
    expect(Object.keys(BUILTIN_LEGACY_ID_TO_LOCAL_ID).sort()).toEqual([
      "char_builtin_brainstorm",
      "char_builtin_coding",
      "char_builtin_goal_tracker",
      "char_builtin_research",
      "char_builtin_support",
      "char_builtin_translator",
      "char_builtin_writer",
    ])
  })

  it("builds overlay runtime ids in the stable namespace", () => {
    expect(builtinCharacterRuntimeId("coding")).toBe(
      `cognia-pack:${BUILTIN_CHARACTERS_PLUGIN_ID}:builtin:coding`
    )
    expect(isOverlayCharacterId(builtinCharacterRuntimeId("coding"))).toBe(true)
  })

  it("agrees with the Support Agent's hard-coded ids", () => {
    expect(BUILTIN_LEGACY_ID_TO_LOCAL_ID[SUPPORT_AGENT_ID]).toBe("support")
    expect(builtinCharacterRuntimeId("support")).toBe(SUPPORT_AGENT_CANONICAL_ID)
  })
})
