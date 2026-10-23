import type { PluginCharacterPackDef } from "@/types/plugin/plugin-character-pack"
import { getBuiltinPrebootManifest } from "@/lib/plugin/core/builtin-preboot-manifests"
import { buildOverlayCharacterId } from "@/lib/plugin/registries/character-pack-registry"

/**
 * The host's view of the built-in character pack (ADR-0030 Amendment / v50).
 *
 * The seven default personas are authored in the `cognia-builtin-characters`
 * first-party plugin, which the manager registers as an overlay pack on enable.
 * First-launch seeding runs before the manager boots, so it reads the same pack
 * from the generated pre-boot snapshot instead of importing plugin source.
 */
export const BUILTIN_CHARACTERS_PLUGIN_ID = "cognia-builtin-characters"

/** Pack id inside the plugin; part of every built-in's overlay runtime id. */
export const BUILTIN_CHARACTER_PACK_ID = "builtin"

/**
 * Stable map from the legacy `char_builtin_*` Dexie ids to the pack's
 * `localId`s.
 *
 * Host-owned: the keys are row ids in the user's database, referenced across
 * the host (team templates, the Support Agent, the immutability guard), and the
 * plugin never reads them. Every value MUST match a `localId` the plugin ships;
 * changing one orphans existing user customisations.
 * `builtin-character-pack.test.ts` pins the round trip against the snapshot.
 */
export const BUILTIN_LEGACY_ID_TO_LOCAL_ID: Readonly<Record<string, string>> = Object.freeze({
  char_builtin_coding: "coding",
  char_builtin_writer: "writer",
  char_builtin_research: "research",
  char_builtin_brainstorm: "brainstorm",
  char_builtin_translator: "translator",
  char_builtin_goal_tracker: "goal-tracker",
  char_builtin_support: "support",
})

/**
 * The built-in pack as the shipped plugin declares it, or `undefined` when the
 * plugin is not part of this build. Seeding then writes no rows rather than
 * inventing personas the plugin does not provide.
 */
export function getBuiltinCharacterPack(): PluginCharacterPackDef | undefined {
  return getBuiltinPrebootManifest(BUILTIN_CHARACTERS_PLUGIN_ID)?.characterPacks?.find(
    (pack) => pack.id === BUILTIN_CHARACTER_PACK_ID
  )
}

/** Overlay runtime id of one built-in, `cognia-pack:<pluginId>:<packId>:<localId>`. */
export function builtinCharacterRuntimeId(localId: string): string {
  return buildOverlayCharacterId(BUILTIN_CHARACTERS_PLUGIN_ID, BUILTIN_CHARACTER_PACK_ID, localId)
}
