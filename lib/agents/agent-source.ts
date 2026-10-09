/**
 * Where an agent came from, and what that allows (ADR-0220, ADR-0030).
 *
 * Three orthogonal facts drive every badge and every action gate on an agent:
 *   - overlay: a synthetic `cognia-pack:` id projected from a registered pack,
 *     not a Dexie row (read-only, undeletable);
 *   - cloned: a Dexie row carrying `sourcePluginId` attribution;
 *   - update available: a clone whose source pack has moved on.
 * The console's table, detail header and action menu all read this one
 * classification, so a row and its detail can never disagree about it.
 */

import type { Character } from "@cognia/agent-config-types"
import type { PluginCharacterPackWarning } from "@/lib/plugin/character-pack/validate-requires"
import { LOCAL_PACK_PLUGIN_ID } from "@/lib/plugin/character-pack/local-pack-store"
import {
  getPackCharacterWarnings,
  getPackWarnings,
  isOverlayCharacterId,
  listCharacterPackEntries,
} from "@/lib/plugin/registries/character-pack-registry"

/** The built-in Cognia Support agent is immutable even though it is a Dexie row. */
const IMMUTABLE_AGENT_IDS = new Set(["char_builtin_support"])

export interface AgentSource {
  isOverlay: boolean
  isCloned: boolean
  /** The plugin that contributed the pack, when there is one. */
  sourcePluginId?: string
  /** True when the contributing "plugin" is a pack file imported from disk. */
  fromLocalFile: boolean
  /** The pack id export would write, when the agent belongs to one. */
  packId?: string
  /** The live pack's version, for a clone whose pack is still registered. */
  livePackVersion?: string
  updateAvailable: boolean
  /** `requires` warnings stamped on the pack at registration. */
  warnings: readonly PluginCharacterPackWarning[]
  /** Its profile can be edited in place. */
  editable: boolean
  /** It can be deleted (variants of it may still block that; see `deleteCharacter`). */
  deletable: boolean
}

export interface AgentSourceDeps {
  isOverlayCharacterId: (id: string) => boolean
  packVersion: (pluginId: string, packId: string) => string | undefined
  packCharacterWarnings: (packId: string, localId: string) => readonly PluginCharacterPackWarning[]
  packWarnings: (packId: string) => readonly PluginCharacterPackWarning[]
}

const defaultDeps: AgentSourceDeps = {
  isOverlayCharacterId,
  packVersion: (pluginId, packId) =>
    listCharacterPackEntries().find((e) => e.entry.id === packId && e.pluginId === pluginId)?.entry
      .version,
  packCharacterWarnings: getPackCharacterWarnings,
  packWarnings: getPackWarnings,
}

/** Split an overlay id `cognia-pack:<plugin>:<pack>:<local…>` into its pack and local ids. */
export function parseOverlayAgentId(id: string): { packId?: string; localId?: string } {
  const segments = id.slice("cognia-pack:".length).split(":")
  const packId = segments[1]
  const localId = segments.slice(2).join(":")
  return { packId: packId || undefined, localId: localId || undefined }
}

export function describeAgentSource(
  character: Character,
  deps: AgentSourceDeps = defaultDeps
): AgentSource {
  const isOverlay = deps.isOverlayCharacterId(character.id)
  const isCloned = !isOverlay && Boolean(character.sourcePluginId)
  const sourcePluginId = character.sourcePluginId
  const overlay = isOverlay ? parseOverlayAgentId(character.id) : undefined
  const packId = overlay?.packId ?? (isCloned ? character.sourcePackId : undefined)
  const livePackVersion =
    isCloned && sourcePluginId && character.sourcePackId
      ? deps.packVersion(sourcePluginId, character.sourcePackId)
      : undefined
  const updateAvailable =
    isCloned &&
    Boolean(character.packVersionAtClone) &&
    Boolean(livePackVersion) &&
    livePackVersion !== character.packVersionAtClone
  let warnings: readonly PluginCharacterPackWarning[] = []
  if (overlay?.packId && overlay.localId) {
    warnings = deps.packCharacterWarnings(overlay.packId, overlay.localId)
  } else if (isCloned && character.sourcePackId) {
    warnings = deps.packWarnings(character.sourcePackId)
  }
  const locked = character.isBuiltIn === true || isOverlay || IMMUTABLE_AGENT_IDS.has(character.id)
  return {
    isOverlay,
    isCloned,
    sourcePluginId,
    fromLocalFile:
      (isOverlay || isCloned) && (!sourcePluginId || sourcePluginId === LOCAL_PACK_PLUGIN_ID),
    packId,
    livePackVersion,
    updateAvailable,
    warnings,
    editable: !locked,
    deletable: character.isBuiltIn !== true && !isOverlay,
  }
}

/**
 * How many clones of each pack are waiting on an update, keyed
 * `<pluginId>:<packId>`. Drives the "apply to all N" batch action, offered
 * once a pack has two or more.
 */
export function countPendingPackUpdates(
  characters: readonly Character[],
  deps: AgentSourceDeps = defaultDeps
): Map<string, number> {
  const map = new Map<string, number>()
  for (const c of characters) {
    if (!c.sourcePluginId || !c.sourcePackId || !c.packVersionAtClone) continue
    const live = deps.packVersion(c.sourcePluginId, c.sourcePackId)
    if (!live || live === c.packVersionAtClone) continue
    const key = `${c.sourcePluginId}:${c.sourcePackId}`
    map.set(key, (map.get(key) ?? 0) + 1)
  }
  return map
}
