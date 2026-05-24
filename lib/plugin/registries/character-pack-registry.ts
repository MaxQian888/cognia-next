/**
 * Character Pack Registry — dynamic overlay for plugin-contributed
 * character packs (ADR-0030).
 *
 * Plugins shipping the `character-pack` capability call
 * `registerCharacterPack` on enable through the
 * `OVERLAY_REGISTRY_CAPABILITIES` dispatch loop in
 * `lib/plugin/core/manager.ts`. On disable the plugin manager calls
 * `unregisterCharacterPacksByPlugin(pluginId)` to drop every pack the
 * plugin contributed in one shot.
 *
 * Two-level identity:
 *   - The pack is stored under `PluginCharacterPackDef.id`.
 *   - Each pack's `characters[]` carry pack-local ids (`localId`); the
 *     host derives the runtime character id as
 *     `cognia-pack:<pluginId>:<packId>:<localId>` so collisions with
 *     Dexie-resident `char_*` ids are impossible (see ADR-0030).
 *
 * The two convenience views `listAllPackCharacters` and
 * `getPackCharacterByRuntimeId` exist so `lib/db/characters.ts`
 * (`listCharacters` union + `resolveCharacterById`) can resolve overlay
 * characters without re-flattening the entries on every call.
 *
 * Per-plugin cleanup: `unregisterCharacterPacksByPlugin(pluginId)`.
 */

import type {
  PluginCharacterPackDef,
  PluginCharacterDef,
} from "@/types/plugin/plugin-character-pack"
import { createValidatingOverlayRegistry } from "./createValidatingOverlayRegistry"
import {
  validatePackRequires,
  type PluginCharacterPackWarning,
} from "@/lib/plugin/character-pack/validate-requires"

const registry = createValidatingOverlayRegistry<
  PluginCharacterPackDef,
  PluginCharacterPackWarning
>({
  name: "character-pack",
  validate: (pack) => validatePackRequires(pack).warnings,
})

/**
 * Register a plugin-contributed character pack and stamp `requires`
 * warnings (ADR-0030 §B.6). Warnings are non-blocking — the pack is
 * registered regardless; consumers (Settings UI) read the warnings via
 * `getPackWarnings(packId)` and surface them as chips on the affected rows.
 */
export const registerCharacterPack = registry.register
/**
 * Re-run `requires` validation for every registered pack. Called when
 * sibling overlay registries (skill / mcp / native-tool) mutate, so a
 * pack that previously had a missing-dep warning clears it once the
 * dependency arrives.
 */
export const refreshAllPackWarnings = registry.refreshAllWarnings
/** Drop a single dynamically-registered pack by id. */
export const unregisterCharacterPackById = registry.unregisterById
/** Drop every pack contributed by `pluginId`. Returns the number removed. */
export const unregisterCharacterPacksByPlugin = registry.unregisterByPlugin
/** Get a pack by id. Returns undefined when not registered. */
export const getCharacterPack = registry.get
/** Get the full registry entry (pack + pluginId tag) for an id. */
export const getCharacterPackEntry = registry.getEntry
/** List every registered pack id in registration order. */
export const listCharacterPackIds = registry.list
/** List every registered entry (id + pack + pluginId) in registration order. */
export const listCharacterPackEntries = registry.entries
/**
 * Return the warnings collected at register time for a pack. Returns
 * an empty array (not undefined) for clean packs so consumers can map
 * without null checks.
 */
export const getPackWarnings = registry.getWarnings
/** Test-only: clear every dynamically registered pack and its warnings. */
export const __resetCharacterPacksForTesting = registry.__resetForTesting

/**
 * Return warnings that apply to a specific overlay character within its
 * pack. Includes pack-level warnings (uniform across all characters in
 * the pack) and character-level warnings whose `characterLocalId` matches.
 */
export function getPackCharacterWarnings(
  packId: string,
  localId: string
): readonly PluginCharacterPackWarning[] {
  return registry
    .getWarnings(packId)
    .filter((w) => !w.characterLocalId || w.characterLocalId === localId)
}

/** Flattened view: every character contributed by every pack. */
export function listAllPackCharacters(): Array<{
  pack: PluginCharacterPackDef
  character: PluginCharacterDef
  pluginId?: string
}> {
  const out: Array<{
    pack: PluginCharacterPackDef
    character: PluginCharacterDef
    pluginId?: string
  }> = []
  for (const { entry: pack, pluginId } of registry.entries()) {
    for (const character of pack.characters) {
      out.push({ pack, character, pluginId })
    }
  }
  return out
}

/**
 * Resolve a synthetic overlay id (`cognia-pack:<pluginId>:<packId>:<localId>`)
 * back to its pack + character + owning pluginId. Returns undefined for any
 * id that doesn't parse or whose pack/character has been unregistered.
 *
 * The resolver tolerates an empty `pluginId` segment (`cognia-pack::<pack>:<local>`)
 * to support local-imported packs registered without a contributing plugin
 * (see `lib/plugin/character-pack/local-pack-store.ts`).
 */
export function getPackCharacterByRuntimeId(runtimeId: string):
  | {
      pack: PluginCharacterPackDef
      character: PluginCharacterDef
      pluginId?: string
    }
  | undefined {
  if (!runtimeId.startsWith("cognia-pack:")) return undefined
  // Split into at most 4 parts so local ids may contain colons. Format is
  // strictly `cognia-pack:<plugin>:<pack>:<local-with-anything>`.
  const rest = runtimeId.slice("cognia-pack:".length)
  const firstColon = rest.indexOf(":")
  if (firstColon < 0) return undefined
  const pluginSegment = rest.slice(0, firstColon)
  const afterPlugin = rest.slice(firstColon + 1)
  const secondColon = afterPlugin.indexOf(":")
  if (secondColon < 0) return undefined
  const packId = afterPlugin.slice(0, secondColon)
  const localId = afterPlugin.slice(secondColon + 1)
  if (!packId || !localId) return undefined

  const entry = registry.getEntry(packId)
  if (!entry) return undefined
  // Plugin segment must match the registered pluginId tag, or both must be
  // empty/anonymous. This prevents one plugin's id from masquerading as
  // another's at resolution time.
  const expectedSegment = entry.pluginId ?? ""
  if (pluginSegment !== expectedSegment) return undefined

  const character = entry.entry.characters.find((c) => c.localId === localId)
  if (!character) return undefined
  return { pack: entry.entry, character, pluginId: entry.pluginId }
}

/**
 * Build the canonical runtime id for an overlay character. Inverse of
 * `getPackCharacterByRuntimeId`. Used by `projectOverlayCharacter` in
 * `lib/db/characters.ts` and by the local-pack store when registering
 * imported packs.
 */
export function buildOverlayCharacterId(
  pluginId: string | undefined,
  packId: string,
  localId: string
): string {
  return `cognia-pack:${pluginId ?? ""}:${packId}:${localId}`
}

/** True if `id` is a synthetic overlay character id; false for Dexie row ids. */
export function isOverlayCharacterId(id: string): boolean {
  return id.startsWith("cognia-pack:")
}
