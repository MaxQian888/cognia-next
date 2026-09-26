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
import {
  CHARACTER_ROW_FIELDS,
  MAX_VARIANT_DEPTH,
  applyVariantOverlay,
  diffVariantOwnFields,
  materializeVariantProfile,
} from "@cognia/agent-config-types/agent-variant"
import { loggers } from "@cognia/logging"

// Resolved on first use: this module is imported by many surfaces, some under
// test doubles of the logging package, and none of them should fail at import.
let cachedLog: ReturnType<typeof loggers.agent.child> | undefined
const log = {
  warn: (...args: Parameters<ReturnType<typeof loggers.agent.child>["warn"]>) =>
    (cachedLog ??= loggers.agent.child("characters")).warn(...args),
}

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
    modelRouting: ch.modelRouting,
    executionPolicy: ch.executionPolicy,
    memoryPolicy: ch.memoryPolicy,
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

/** The stored row for an id: a Dexie row, else a plugin-pack overlay projection. */
async function loadCharacterRow(id: string): Promise<Character | undefined> {
  const row = await getCharacter(id)
  if (row) return row
  if (!isOverlayCharacterId(id)) return undefined
  const overlay = getPackCharacterByRuntimeId(id)
  if (!overlay) return undefined
  return projectOverlayCharacter(overlay.pack, overlay.character, overlay.pluginId)
}

/**
 * The effective agent for a row: a variant overlays its base's current
 * profile. `chain` holds the ids already on the path, so a cycle or a chain
 * past {@link MAX_VARIANT_DEPTH} stops there. When the base cannot be resolved
 * the row's own materialized profile is the answer, which keeps the agent's
 * last known prompt and tools instead of degrading to an empty persona.
 */
async function resolveVariantChain(
  row: Character,
  chain: ReadonlySet<string>,
  load: (id: string) => Promise<Character | undefined> = loadCharacterRow
): Promise<Character> {
  const link = row.variant
  if (!link) return row
  if (chain.has(link.baseId) || chain.size >= MAX_VARIANT_DEPTH) {
    log.warn("agent variant chain stopped; using the stored profile", {
      id: row.id,
      baseId: link.baseId,
      reason: chain.has(link.baseId) ? "cycle" : "depth",
    })
    return row
  }
  const baseRow = await load(link.baseId)
  if (!baseRow) {
    log.warn("agent variant base is missing; using the stored profile", {
      id: row.id,
      baseId: link.baseId,
    })
    return row
  }
  const base = await resolveVariantChain(baseRow, new Set([...chain, link.baseId]), load)
  return applyVariantOverlay(row, base)
}

/**
 * Two-tier lookup (ADR-0030). Dexie row first (built-ins + user-created +
 * user-cloned), then plugin overlay packs by synthetic id. A variant comes
 * back with its base's current profile applied (see `./agent-variant`).
 * Returns undefined when neither source has the id — callers (notably
 * `lib/claude/build-options.ts:resolveSendOptions` and the chat header)
 * treat undefined as "character disappeared" and fall back to app
 * defaults, possibly surfacing a banner to the user.
 */
export async function resolveCharacterById(id: string): Promise<Character | undefined> {
  const row = await loadCharacterRow(id)
  return row ? resolveVariantChain(row, new Set([id])) : undefined
}

/**
 * Apply variant overlays across an already-loaded list (the settings list,
 * pickers). Bases are looked up in the list first, then in storage, so a
 * variant of a hidden or unlisted agent still resolves.
 */
export async function resolveCharacterVariants(rows: readonly Character[]): Promise<Character[]> {
  const byId = new Map(rows.map((row) => [row.id, row]))
  const load = async (id: string) => byId.get(id) ?? loadCharacterRow(id)
  return Promise.all(rows.map((row) => resolveVariantChain(row, new Set([row.id]), load)))
}

/** `listCharacters` with every variant showing its effective profile. */
export async function listResolvedCharacters(): Promise<Character[]> {
  return resolveCharacterVariants(await listCharacters())
}

/** Variant rows whose base is `baseId`. */
export async function listCharacterVariants(baseId: string): Promise<Character[]> {
  return getDb()
    .characters.filter((row) => row.variant?.baseId === baseId)
    .toArray()
}

/** Raised when deleting an agent that other agents are variants of. */
export class CharacterHasVariantsError extends Error {
  readonly variantNames: string[]

  constructor(id: string, variantNames: string[]) {
    super(
      `Agent ${id} is the base of ${variantNames.length} variant(s): ${variantNames.join(", ")}. Detach or delete them first.`
    )
    this.name = "CharacterHasVariantsError"
    this.variantNames = variantNames
  }
}

/** The row fields an object carries (`key in` so an explicit clear counts). */
function rowFieldsOf(source: Partial<Character>): Partial<Character> {
  const out: Record<string, unknown> = {}
  for (const key of CHARACTER_ROW_FIELDS) {
    if (key in source) out[key] = (source as Record<string, unknown>)[key]
  }
  return out as Partial<Character>
}

/**
 * Create a variant of `baseId` named `name`. It starts owning nothing, so it
 * behaves exactly like the base until edited. The base may be a user agent, a
 * built-in, a plugin-pack overlay, or another variant.
 */
export async function createCharacterVariant(baseId: string, name: string): Promise<Character> {
  const base = await resolveCharacterById(baseId)
  if (!base) throw new Error(`Character ${baseId} not found`)
  const now = Date.now()
  const variant: Character = {
    ...(materializeVariantProfile(base) as Omit<Character, "id" | "name" | "avatarColor">),
    id: newId(),
    name: name.trim() || base.name,
    avatarColor: base.avatarColor,
    ...(base.avatarEmoji ? { avatarEmoji: base.avatarEmoji } : {}),
    ...(base.avatarImage ? { avatarImage: base.avatarImage } : {}),
    ...(base.description ? { description: base.description } : {}),
    systemPrompt: base.systemPrompt,
    variant: { baseId, ownFields: [] },
    createdAt: now,
    updatedAt: now,
  }
  await getDb().characters.put(variant)
  return variant
}

/**
 * Save an edit to a variant. The patch is applied to the variant's effective
 * agent, and the variant then owns exactly the profile fields that differ
 * from its base, so a field edited back to the base's value follows the base
 * again. The row keeps a full materialized profile as its fallback.
 */
async function saveVariantEdit(row: Character, patch: Partial<Character>): Promise<void> {
  const link = row.variant
  if (!link) throw new Error(`Character ${row.id} is not a variant`)
  const base = await resolveCharacterById(link.baseId)
  if (!base) {
    throw new Error(
      `The base of agent ${row.id} (${link.baseId}) is missing. Detach the variant to keep editing it.`
    )
  }
  const effective = await resolveVariantChain(row, new Set([row.id]))
  const edited = { ...effective, ...patch } as Character
  const next = {
    ...rowFieldsOf(row),
    ...rowFieldsOf(patch),
    ...materializeVariantProfile(edited),
    id: row.id,
    createdAt: row.createdAt,
    variant: { baseId: link.baseId, ownFields: diffVariantOwnFields(base, edited) },
    updatedAt: Date.now(),
  } as Character
  await getDb().characters.put(next)
}

/**
 * Turn a variant into an ordinary agent holding its current effective profile.
 * It stops following its base from here on.
 */
export async function detachCharacterVariant(id: string): Promise<Character> {
  const row = await getCharacter(id)
  if (!row?.variant) throw new Error(`Character ${id} is not a variant`)
  const effective = await resolveVariantChain(row, new Set([id]))
  const next = {
    ...rowFieldsOf(row),
    ...materializeVariantProfile(effective),
    variant: undefined,
    updatedAt: Date.now(),
  } as Character
  delete (next as Partial<Character>).variant
  await getDb().characters.put(next)
  return next
}

/** Drop every override so the variant follows its base again. */
export async function resetCharacterVariant(id: string): Promise<Character> {
  const row = await getCharacter(id)
  if (!row?.variant) throw new Error(`Character ${id} is not a variant`)
  const base = await resolveCharacterById(row.variant.baseId)
  if (!base) throw new Error(`The base of agent ${id} (${row.variant.baseId}) is missing`)
  const next = {
    ...rowFieldsOf(row),
    ...materializeVariantProfile(base),
    variant: { baseId: row.variant.baseId, ownFields: [] },
    updatedAt: Date.now(),
  } as Character
  await getDb().characters.put(next)
  return next
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
  // Variants resolve against their bases the same way a single lookup does.
  for (const [index, row] of dexieRows.entries()) {
    if (row?.variant) dexieRows[index] = await resolveVariantChain(row, new Set([row.id]))
  }
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

/**
 * Everything a caller may set on a new character. Identity, timestamps and the
 * built-in flag belong to the store.
 */
export type CharacterDraft = Pick<Character, "name" | "systemPrompt"> &
  Partial<Omit<Character, "id" | "name" | "systemPrompt" | "createdAt" | "updatedAt" | "isBuiltIn">>

/** Fields the store assigns, stripped even when a caller's object carries them. */
const STORE_OWNED_CHARACTER_FIELDS = ["id", "createdAt", "updatedAt", "isBuiltIn"] as const

export async function createCharacter(draft: CharacterDraft): Promise<Character> {
  const now = Date.now()
  // Every profile field the caller set is kept. A hand-maintained copy list
  // here silently dropped each field added after it was written (computer use,
  // sandbox, account override…), so a new agent lost settings its editor showed.
  const fields: Partial<Character> = { ...draft }
  for (const key of STORE_OWNED_CHARACTER_FIELDS) delete fields[key]
  const character: Character = {
    ...fields,
    id: newId(),
    name: draft.name.trim() || "Untitled character",
    avatarColor: draft.avatarColor ?? "oklch(0.7 0.15 250)",
    systemPrompt: draft.systemPrompt,
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
  if (id === "char_builtin_support") {
    throw new Error("The built-in Cognia Support Agent is immutable. Duplicate it first.")
  }
  // A variant's profile edits decide which fields it owns; writing them
  // straight onto the row would store values its base then shadows. The link
  // itself is recomputed, so a patch that carries a stale `variant` (a whole
  // effective agent spread back in) cannot corrupt it. Detaching and resetting
  // have their own operations.
  const existing = await getDb().characters.get(id)
  if (existing?.variant) {
    await saveVariantEdit(existing, patch)
    return
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
  const variants = await listCharacterVariants(id)
  if (variants.length > 0) {
    throw new CharacterHasVariantsError(
      id,
      variants.map((variant) => variant.name)
    )
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
    // A duplicate is a detached copy of what the variant currently is.
    if (source.variant) {
      const effective: Character = await resolveVariantChain(source, new Set([id]))
      source = { ...effective }
      delete source.variant
    }
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
