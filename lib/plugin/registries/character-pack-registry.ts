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
import { UNSIGNED_TRUST, type CharacterPackTrust } from "@/lib/plugin/character-pack/pack-trust"

const registry = createValidatingOverlayRegistry<
  PluginCharacterPackDef,
  PluginCharacterPackWarning
>({
  name: "character-pack",
  validate: (pack) => validatePackRequires(pack).warnings,
})

/**
 * Trust state per pack id, kept beside the registry rather than inside it.
 *
 * Deliberately NOT the overlay registry's `meta` bag. `registerCharacterPack`
 * is re-exported from `@cognia/plugin-sdk`, so anything a plugin can pass
 * through it is attacker-controlled — a `meta.trust = "verified"` write would
 * let any plugin mint a verified badge for itself. Only
 * `registerCharacterPackWithTrust`, which is host-only and deliberately not in
 * the SDK surface, can set anything other than `unsigned`.
 */
const trustByPackId = new Map<string, CharacterPackTrust>()

const listeners = new Set<() => void>()
let version = 0

function notify(): void {
  version += 1
  for (const listener of listeners) {
    try {
      listener()
    } catch {
      // One bad subscriber must not break a registry mutation.
    }
  }
}

/**
 * Register a plugin-contributed character pack and stamp `requires`
 * warnings (ADR-0030 §B.6). Warnings are non-blocking — the pack is
 * registered regardless; consumers (Settings UI) read the warnings via
 * `getPackWarnings(packId)` and surface them as chips on the affected rows.
 *
 * Trust is forced to `unsigned`. A plugin re-registering over a pack id that a
 * verified local file previously held must not inherit its badge.
 */
export const registerCharacterPack: typeof registry.register = (...args) => {
  const result = registry.register(...args)
  trustByPackId.set(args[0], UNSIGNED_TRUST)
  notify()
  return result
}

/**
 * Host-only registration that carries a computed trust state.
 *
 * NOT exported from `@cognia/plugin-sdk` — see the note on `trustByPackId`.
 */
export function registerCharacterPackWithTrust(
  id: string,
  pack: PluginCharacterPackDef,
  opts: { pluginId?: string; trust: CharacterPackTrust }
): void {
  registry.register(id, pack, { pluginId: opts.pluginId })
  trustByPackId.set(id, opts.trust)
  notify()
}

/** Trust state for a pack. Unknown and plugin-contributed packs are `unsigned`. */
export function getPackTrust(packId: string): CharacterPackTrust {
  return trustByPackId.get(packId) ?? UNSIGNED_TRUST
}

/**
 * Re-run `requires` validation for every registered pack. Called when
 * sibling registries (skill / mcp / native-tool / theme-pack / connector /
 * provider) mutate, so a pack that previously had a missing-dep warning clears
 * it once the dependency arrives.
 */
export const refreshAllPackWarnings = (): void => {
  registry.refreshAllWarnings()
  // The warnings map is invisible to React on its own; without this a cleared
  // warning would keep rendering until some unrelated re-render happened.
  notify()
}
/** Drop a single dynamically-registered pack by id. */
export const unregisterCharacterPackById: typeof registry.unregisterById = (id) => {
  const result = registry.unregisterById(id)
  trustByPackId.delete(id)
  notify()
  return result
}
/** Drop every pack contributed by `pluginId`. Returns the number removed. */
export const unregisterCharacterPacksByPlugin: typeof registry.unregisterByPlugin = (pluginId) => {
  for (const { id, pluginId: owner } of registry.entries()) {
    if (owner === pluginId) trustByPackId.delete(id)
  }
  const removed = registry.unregisterByPlugin(pluginId)
  notify()
  return removed
}
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
/** Test-only: clear every dynamically registered pack, its warnings, and trust. */
export const __resetCharacterPacksForTesting = (): void => {
  registry.__resetForTesting()
  trustByPackId.clear()
  notify()
}

/**
 * Subscribe to registry mutations (register / unregister / warning refresh).
 *
 * Needed because two things are invisible to React otherwise: local pack
 * import/delete/rescan, and `refreshAllPackWarnings` clearing a warning in the
 * sidecar map.
 *
 * Pair with {@link getCharacterPackRegistryVersion} in `useSyncExternalStore`.
 * Never snapshot `listCharacterPackEntries()` — it allocates a fresh array on
 * every call, which makes React loop forever.
 */
export function subscribeCharacterPackRegistry(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Monotonic counter — the correct `useSyncExternalStore` snapshot. */
export function getCharacterPackRegistryVersion(): number {
  return version
}

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
