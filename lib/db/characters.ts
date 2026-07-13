import type { Character } from "@cognia/agent-config-types"
import type {
  PluginCharacterDef,
  PluginCharacterPackDef,
} from "@/types/plugin/plugin-character-pack"
import {
  buildOverlayCharacterId,
  getPackCharacterByRuntimeId,
  isOverlayCharacterId,
  listAllPackCharacters,
} from "@/lib/plugin/registries/character-pack-registry"
import {
  buildPristineSnapshot,
  diffPackUpdate,
  type PackUpdateDiff,
} from "@/lib/plugin/character-pack/diff-pack-update"
// ADR-0030 Amendment / v50 — built-in characters now live in a first-party
// plugin. The Dexie seed reuses the same character defs to keep the
// pre-plugin-boot first-launch rows in sync with the overlay.
import {
  BUILTIN_LEGACY_ID_TO_LOCAL_ID,
  BUILTIN_PACK,
  BUILTIN_PLUGIN_ID,
} from "@/plugins/cognia-builtin-characters/src/index"
import { getDb } from "./schema"
import { recordTombstones } from "@/lib/sync/tombstones"

function newId() {
  return "char_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

/**
 * Project a plugin-contributed `PluginCharacterDef` into a transient
 * `Character` row (ADR-0030). The returned row is NOT persisted to Dexie —
 * it lives in memory for the duration of the overlay registration. The
 * synthetic `id` uses the `cognia-pack:` namespace
 * (`cognia-pack:<pluginId>:<packId>:<localId>`) so it never collides with
 * the Dexie-resident `char_*` namespace.
 *
 * `createdAt` / `updatedAt` are pinned to 0 as deterministic sentinels so
 * UI sort-by-recency surfaces never mistake an overlay row for a fresh
 * user creation. The `sourcePluginId` / `sourcePackId` fields piggyback on
 * the Character schema (added by ADR-0030) so the row's plugin origin
 * survives projection without a separate side-channel.
 */
export function projectOverlayCharacter(
  pack: PluginCharacterPackDef,
  ch: PluginCharacterDef,
  pluginId?: string
): Character {
  return {
    id: buildOverlayCharacterId(pluginId, pack.id, ch.localId),
    name: ch.name,
    description: ch.description,
    avatarColor: ch.avatarColor,
    avatarEmoji: ch.avatarEmoji,
    systemPrompt: ch.systemPrompt,
    model: ch.model,
    providerId: ch.providerId,
    permissionMode: ch.permissionMode,
    allowedTools: ch.allowedTools,
    disallowedTools: ch.disallowedTools,
    mcpServerIds: ch.mcpServerIds,
    skillIds: ch.skillIds,
    pluginSkillIds: ch.pluginSkillIds,
    workingDir: ch.workingDir,
    bareMode: ch.bareMode,
    debugMode: ch.debugMode,
    briefMode: ch.briefMode,
    enableComputerUse: ch.enableComputerUse,
    computerUseSettings: ch.computerUseSettings,
    sandboxEnabled: ch.sandboxEnabled,
    sandboxTier: ch.sandboxTier,
    platformDefaults: ch.platformDefaults,
    a2uiEnabled: ch.a2uiEnabled,
    a2uiCatalogId: ch.a2uiCatalogId,
    isBuiltIn: false,
    sourcePluginId: pluginId,
    sourcePackId: pack.id,
    // v2 projection — transparent pass-through. UI consumers read these
    // off the projected row instead of round-tripping back to the
    // overlay registry.
    avatarImage: ch.avatarImage,
    persona: ch.persona,
    voiceProfile: ch.voiceProfile,
    availableOnPlatforms: ch.availableOnPlatforms,
    createdAt: 0,
    updatedAt: 0,
  }
}

export async function listCharacters(): Promise<Character[]> {
  const dexie = await getDb().characters.orderBy("name").toArray()
  const overlay = listAllPackCharacters().map(({ pack, character, pluginId }) =>
    projectOverlayCharacter(pack, character, pluginId)
  )
  // Two dedupe rules — both keep the persisted Dexie row in front of the
  // overlay row when the two represent the same character:
  //   1. id-collision (defensive belt-and-braces — physically impossible
  //      under the `cognia-pack:` namespace, but cheap to enforce).
  //   2. clone-hides-overlay (v49) — a Dexie row whose
  //      `clonedFromPackCharacterId` points at an overlay synthetic id
  //      means "this user already cloned that overlay into their library".
  //      Showing both would duplicate the persona in the picker. The Dexie
  //      row wins because it can carry user edits + Apply-Update history.
  const byId = new Map<string, Character>()
  const hiddenOverlayIds = new Set<string>()
  for (const row of dexie) {
    byId.set(row.id, row)
    if (row.clonedFromPackCharacterId) {
      hiddenOverlayIds.add(row.clonedFromPackCharacterId)
    }
  }
  for (const row of overlay) {
    if (byId.has(row.id)) continue
    if (hiddenOverlayIds.has(row.id)) continue
    byId.set(row.id, row)
  }
  return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name))
}

export async function getCharacter(id: string): Promise<Character | undefined> {
  return getDb().characters.get(id)
}

/**
 * Two-tier lookup (ADR-0030). Dexie row first (built-ins + user-created +
 * user-cloned), then plugin overlay packs by synthetic id. Returns
 * undefined when neither source has the id — callers (notably
 * `lib/claude/build-options.ts:resolveSendOptions` and the chat header)
 * treat undefined as "character disappeared" and fall back to app
 * defaults, possibly surfacing a banner to the user.
 */
export async function resolveCharacterById(id: string): Promise<Character | undefined> {
  const row = await getCharacter(id)
  if (row) return row
  if (!isOverlayCharacterId(id)) return undefined
  const overlay = getPackCharacterByRuntimeId(id)
  if (!overlay) return undefined
  return projectOverlayCharacter(overlay.pack, overlay.character, overlay.pluginId)
}

export async function listCharactersByIds(ids: string[]): Promise<Character[]> {
  if (ids.length === 0) return []
  // Split Dexie ids and overlay synthetic ids. We can do a single bulkGet
  // on Dexie ids for efficiency; overlay ids are resolved one at a time
  // from the in-memory registry (it's a Map, so each lookup is O(1)).
  const dexieIds: string[] = []
  const overlayIds: string[] = []
  for (const id of ids) {
    if (isOverlayCharacterId(id)) overlayIds.push(id)
    else dexieIds.push(id)
  }
  const dexieRows = dexieIds.length > 0 ? await getDb().characters.bulkGet(dexieIds) : []
  // Re-index by id so we can splice results back in caller order.
  const byId = new Map<string, Character>()
  for (const row of dexieRows) {
    if (row) byId.set(row.id, row)
  }
  for (const id of overlayIds) {
    const overlay = getPackCharacterByRuntimeId(id)
    if (overlay)
      byId.set(id, projectOverlayCharacter(overlay.pack, overlay.character, overlay.pluginId))
  }
  const out: Character[] = []
  for (const id of ids) {
    const row = byId.get(id)
    if (row) out.push(row)
  }
  return out
}

export type CharacterDraft = Pick<Character, "name" | "systemPrompt"> &
  Partial<
    Pick<
      Character,
      | "description"
      | "avatarColor"
      | "avatarEmoji"
      | "model"
      | "permissionMode"
      | "allowedTools"
      | "disallowedTools"
      | "mcpServerIds"
      | "skillIds"
      | "workingDir"
      | "bareMode"
      | "debugMode"
      | "briefMode"
      | "twinId"
      | "twinSettings"
      | "sourcePluginId"
      | "sourcePackId"
      | "clonedFromPackCharacterId"
      | "packVersionAtClone"
      | "pristineSnapshot"
      | "avatarImage"
      | "persona"
      | "voiceProfile"
      | "availableOnPlatforms"
    >
  >

export async function createCharacter(draft: CharacterDraft): Promise<Character> {
  const now = Date.now()
  const character: Character = {
    id: newId(),
    name: draft.name.trim() || "Untitled character",
    description: draft.description,
    avatarColor: draft.avatarColor ?? "oklch(0.7 0.15 250)",
    avatarEmoji: draft.avatarEmoji,
    systemPrompt: draft.systemPrompt,
    model: draft.model,
    permissionMode: draft.permissionMode,
    allowedTools: draft.allowedTools,
    disallowedTools: draft.disallowedTools,
    mcpServerIds: draft.mcpServerIds,
    skillIds: draft.skillIds,
    workingDir: draft.workingDir,
    bareMode: draft.bareMode,
    debugMode: draft.debugMode,
    briefMode: draft.briefMode,
    twinId: draft.twinId,
    twinSettings: draft.twinSettings,
    sourcePluginId: draft.sourcePluginId,
    sourcePackId: draft.sourcePackId,
    clonedFromPackCharacterId: draft.clonedFromPackCharacterId,
    packVersionAtClone: draft.packVersionAtClone,
    pristineSnapshot: draft.pristineSnapshot,
    avatarImage: draft.avatarImage,
    persona: draft.persona,
    voiceProfile: draft.voiceProfile,
    availableOnPlatforms: draft.availableOnPlatforms,
    createdAt: now,
    updatedAt: now,
  }
  await getDb().characters.put(character)
  return character
}

export async function updateCharacter(
  id: string,
  patch: Partial<Omit<Character, "id" | "createdAt" | "isBuiltIn">>
): Promise<void> {
  if (isOverlayCharacterId(id)) {
    throw new Error(
      "Plugin-overlay characters are read-only. Duplicate the character first to create an editable copy."
    )
  }
  await getDb().characters.update(id, { ...patch, updatedAt: Date.now() })
}

export async function deleteCharacter(id: string): Promise<void> {
  if (isOverlayCharacterId(id)) {
    throw new Error(
      "Plugin-overlay characters cannot be deleted. Disable the contributing plugin instead."
    )
  }
  const existing = await getDb().characters.get(id)
  if (existing?.isBuiltIn) {
    throw new Error("Built-in characters cannot be deleted. Duplicate first.")
  }
  await getDb().characters.delete(id)
  // Mirror the deletion to paired phones via the companion sync (v61).
  await recordTombstones("characters", [id])
}

/**
 * Clone a character — Dexie row OR plugin overlay — into a new editable
 * Dexie row. When the source is a plugin overlay, the copy carries
 * `sourcePluginId` / `sourcePackId` / `clonedFromPackCharacterId` /
 * `packVersionAtClone` so the Settings UI can later surface
 * "Update available" when the contributing plugin ships a newer pack
 * version. The copy is never marked as built-in regardless of source.
 */
export async function duplicateCharacter(id: string): Promise<Character> {
  let source: Character | undefined
  let pack: PluginCharacterPackDef | undefined
  let sourcePluginId: string | undefined

  if (isOverlayCharacterId(id)) {
    const overlay = getPackCharacterByRuntimeId(id)
    if (!overlay) throw new Error(`Character ${id} not found`)
    source = projectOverlayCharacter(overlay.pack, overlay.character, overlay.pluginId)
    pack = overlay.pack
    sourcePluginId = overlay.pluginId
  } else {
    source = await getDb().characters.get(id)
    if (!source) throw new Error(`Character ${id} not found`)
  }

  // Capture a pristineSnapshot of the pack-managed fields so a future
  // Apply Update can tell user edits from outdated copies (ADR-0030 v49).
  // Source resolution order:
  //   1. Overlay source — snapshot the current overlay character verbatim.
  //   2. Dexie source whose `clonedFromPackCharacterId` resolves — snapshot
  //      the live overlay so the duplicate's baseline matches the latest
  //      pack version (this is what makes "Apply Update" sensible for
  //      copies-of-built-ins after a pack rev).
  //   3. Otherwise — inherit the source's existing snapshot (chained
  //      duplicates of user characters keep their original baseline).
  let overlayChar: PluginCharacterDef | undefined
  if (pack) {
    overlayChar = getPackCharacterByRuntimeId(id)?.character
  } else if (source.clonedFromPackCharacterId) {
    overlayChar = getPackCharacterByRuntimeId(source.clonedFromPackCharacterId)?.character
  }
  const nextSnapshot = overlayChar ? buildPristineSnapshot(overlayChar) : source.pristineSnapshot

  const now = Date.now()
  const copy: Character = {
    ...source,
    id: newId(),
    name: `${source.name} (copy)`,
    isBuiltIn: false,
    // Overlay-source attribution. For non-overlay sources these stay
    // undefined; for overlay sources they capture the link back to the
    // contributing plugin/pack for the "Update available" comparison.
    sourcePluginId: pack ? sourcePluginId : source.sourcePluginId,
    sourcePackId: pack ? pack.id : source.sourcePackId,
    clonedFromPackCharacterId: pack ? id : source.clonedFromPackCharacterId,
    packVersionAtClone: pack ? pack.version : source.packVersionAtClone,
    pristineSnapshot: nextSnapshot,
    createdAt: now,
    updatedAt: now,
  }
  await getDb().characters.put(copy)
  return copy
}

/**
 * Dismiss the "Update available" indicator on a cloned row by snapping
 * `packVersionAtClone` to the current pack version. Used when the user
 * explicitly clicks Dismiss on the badge — they're saying "I'm aware of
 * the new version but choosing to stay on my edited copy". The clone
 * itself stays unchanged; only the comparison cursor moves. (ADR-0030 §D.3)
 *
 * Returns the new pack version on success, or undefined if the row does
 * not look like a clone (no `sourcePluginId` or no `sourcePackId`) or
 * has already been dismissed.
 */
export async function dismissPackUpdate(
  id: string,
  newPackVersion: string
): Promise<string | undefined> {
  const row = await getDb().characters.get(id)
  if (!row || !row.sourcePluginId || !row.sourcePackId) return undefined
  if (row.packVersionAtClone === newPackVersion) return undefined
  await getDb().characters.update(id, {
    packVersionAtClone: newPackVersion,
    updatedAt: Date.now(),
  })
  return newPackVersion
}

/**
 * Result returned by {@link applyPackUpdate}. `undefined` means the update
 * could not run — either the row isn't a clone, the overlay pack is no
 * longer registered, or the row's `clonedFromPackCharacterId` doesn't
 * resolve. Callers should treat undefined as "no-op, surface a toast".
 */
export interface ApplyPackUpdateResult {
  /** Field names that were overwritten on the row. */
  overwrittenFields: string[]
  /** Field names the user had edited and which were therefore preserved. */
  preservedFields: string[]
  /** New `packVersionAtClone` value persisted on the row. */
  packVersion: string
  /** True when the row lacked a pristineSnapshot and we overwrote-all. */
  noBaseline: boolean
}

/**
 * Apply an "Update available" update to a single cloned character row
 * (ADR-0030 v49). Pulls the current overlay character, diffs against the
 * row's pristineSnapshot, writes back only the fields the user hasn't
 * touched, and snaps the row's `packVersionAtClone` + `pristineSnapshot`
 * forward so the badge clears.
 *
 * Returns `undefined` when the row isn't a clone (no `sourcePluginId` /
 * `sourcePackId` / `clonedFromPackCharacterId`) or when the overlay
 * pack is no longer registered. Callers (the Settings UI) treat
 * `undefined` as "nothing to do" and avoid showing a toast.
 */
export async function applyPackUpdate(
  characterId: string
): Promise<ApplyPackUpdateResult | undefined> {
  const row = await getDb().characters.get(characterId)
  if (!row) return undefined
  if (!row.sourcePluginId || !row.sourcePackId || !row.clonedFromPackCharacterId) {
    return undefined
  }
  const lookup = getPackCharacterByRuntimeId(row.clonedFromPackCharacterId)
  if (!lookup) return undefined
  const diff = diffPackUpdate(row, lookup.character)
  await writeAppliedUpdate(row.id, diff, lookup.pack.version)
  return {
    overwrittenFields: diff.willOverwrite.map((c) => c.field),
    preservedFields: diff.preserved.map((c) => c.field),
    packVersion: lookup.pack.version,
    noBaseline: diff.noBaseline,
  }
}

/**
 * Compute a single-row diff without touching Dexie — used by the dialog
 * preview to render before/after columns. Returns undefined when the
 * row isn't a clone or the overlay pack is gone, mirroring
 * {@link applyPackUpdate}'s no-op semantics.
 */
export async function previewPackUpdate(
  characterId: string
): Promise<{ diff: PackUpdateDiff; packVersion: string } | undefined> {
  const row = await getDb().characters.get(characterId)
  if (!row || !row.sourcePluginId || !row.sourcePackId || !row.clonedFromPackCharacterId) {
    return undefined
  }
  const lookup = getPackCharacterByRuntimeId(row.clonedFromPackCharacterId)
  if (!lookup) return undefined
  return { diff: diffPackUpdate(row, lookup.character), packVersion: lookup.pack.version }
}

/**
 * Batch variant — apply updates to every row in Dexie that clones from
 * the given pack. Skips rows already at the live pack version and rows
 * whose overlay character has vanished from the pack.
 */
export async function applyPackUpdateForPack(
  sourcePluginId: string,
  sourcePackId: string
): Promise<ApplyPackUpdateResult[]> {
  const rows = await getDb().characters.toArray()
  const clones = rows.filter(
    (r) => r.sourcePluginId === sourcePluginId && r.sourcePackId === sourcePackId
  )
  const results: ApplyPackUpdateResult[] = []
  for (const row of clones) {
    const result = await applyPackUpdate(row.id)
    if (result) results.push(result)
  }
  return results
}

/**
 * Helper used by both single + batch apply paths. Builds the patch from a
 * pre-computed diff and persists it with a fresh `packVersionAtClone` +
 * snapshot. Kept private so the only externally callable forms are the
 * id-driven {@link applyPackUpdate} / {@link applyPackUpdateForPack}.
 */
async function writeAppliedUpdate(
  id: string,
  diff: PackUpdateDiff,
  packVersion: string
): Promise<void> {
  // Dexie's `update` ignores undefined-valued keys; we need to actually
  // delete those keys for the "overlay dropped this field" case. Use
  // `modify` (typed as Character) with a cast to a mutable record so the
  // `delete row[field]` path satisfies TypeScript without losing the
  // structural type at the call site.
  await getDb()
    .characters.where("id")
    .equals(id)
    .modify((obj) => {
      const row = obj as unknown as Record<string, unknown>
      for (const [field, value] of Object.entries(diff.overwrites)) {
        if (value === undefined) {
          delete row[field]
        } else {
          row[field] = value
        }
      }
      row.pristineSnapshot = diff.nextSnapshot
      row.packVersionAtClone = packVersion
      row.updatedAt = Date.now()
    })
}

/**
 * Idempotently insert built-in characters (v50 + ADR-0030 Amendment).
 *
 * Pre-v50, this function hard-coded six character rows into Dexie. v50
 * moves the canonical definitions into the
 * `cognia-builtin-characters` first-party plugin and tags the legacy
 * `char_builtin_*` rows with attribution to the new overlay character.
 * Surviving callers (`lib/db/seed.ts:seedBuiltIns`) get the same
 * guarantee: after this resolves, six built-in rows exist in Dexie
 * with stable ids, `isBuiltIn: true`, and matching pack attribution.
 *
 * Why we still write to Dexie at all (rather than fully delegating to
 * the overlay): on first launch the plugin manager has not booted yet,
 * so the overlay registry is empty. Persisting the six rows means the
 * picker is populated even before plugin activation completes. After
 * the plugin enables, the dedupe rule in `listCharacters` hides the
 * overlay copies because every row's `clonedFromPackCharacterId` points
 * back at them.
 */
export async function seedBuiltInCharacters(): Promise<void> {
  const db = getDb()
  const now = Date.now()
  const charsByLocalId = new Map<string, PluginCharacterDef>(
    BUILTIN_PACK.characters.map((c) => [c.localId, c])
  )
  const legacyIds = Object.keys(BUILTIN_LEGACY_ID_TO_LOCAL_ID)
  const existing = await db.characters.bulkGet(legacyIds)
  const existingById = new Map<string, Character | undefined>(
    legacyIds.map((id, i) => [id, existing[i]])
  )

  const toInsert: Character[] = []
  for (const [legacyId, localId] of Object.entries(BUILTIN_LEGACY_ID_TO_LOCAL_ID)) {
    if (existingById.get(legacyId)) continue
    const def = charsByLocalId.get(localId)
    if (!def) continue
    const runtimeId = `cognia-pack:${BUILTIN_PLUGIN_ID}:${BUILTIN_PACK.id}:${localId}`
    // Prefer the live overlay snapshot when the plugin is already up;
    // otherwise build the snapshot from the static pack definition so
    // first-launch rows still have a baseline for Apply Update.
    const overlayChar = getPackCharacterByRuntimeId(runtimeId)?.character ?? def
    toInsert.push({
      id: legacyId,
      name: def.name,
      description: def.description,
      avatarColor: def.avatarColor,
      avatarEmoji: def.avatarEmoji,
      systemPrompt: def.systemPrompt,
      permissionMode: def.permissionMode,
      isBuiltIn: true,
      sourcePluginId: BUILTIN_PLUGIN_ID,
      sourcePackId: BUILTIN_PACK.id,
      clonedFromPackCharacterId: runtimeId,
      packVersionAtClone: BUILTIN_PACK.version,
      pristineSnapshot: buildPristineSnapshot(overlayChar),
      createdAt: now,
      updatedAt: now,
    })
  }
  if (toInsert.length > 0) {
    await db.characters.bulkPut(toInsert)
  }

  // Backfill `pristineSnapshot` on existing tagged rows that never got
  // one. Happens on the v50-upgrade path: the upgrade hook tags rows
  // but can't snapshot because the plugin manager hasn't booted. By
  // the time `seedBuiltInCharacters` runs, the plugin may be active
  // (overlay registry populated). Idempotent — rows with an existing
  // snapshot are left alone.
  for (const [legacyId, localId] of Object.entries(BUILTIN_LEGACY_ID_TO_LOCAL_ID)) {
    const row = existingById.get(legacyId)
    if (!row) continue
    if (row.pristineSnapshot) continue
    if (row.sourcePluginId && row.sourcePluginId !== BUILTIN_PLUGIN_ID) continue
    const def = charsByLocalId.get(localId)
    if (!def) continue
    const runtimeId = `cognia-pack:${BUILTIN_PLUGIN_ID}:${BUILTIN_PACK.id}:${localId}`
    const overlayChar = getPackCharacterByRuntimeId(runtimeId)?.character ?? def
    await db.characters.update(legacyId, {
      pristineSnapshot: buildPristineSnapshot(overlayChar),
    })
  }
}
