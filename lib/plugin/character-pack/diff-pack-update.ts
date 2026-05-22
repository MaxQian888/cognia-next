/**
 * Selective Apply Update diff (ADR-0030, v49).
 *
 * Computes the partial Dexie patch + preserved-field list for the
 * "Apply update" button in Settings → Characters. Pure function — no
 * Dexie access, no global state — so it can be unit-tested in
 * isolation and shared between the dialog preview and the actual write.
 *
 * Field policy:
 *   1. `USER_OWNED_FIELDS` always preserved regardless of edits.
 *   2. Every {@link PackPristineSnapshot} field is "pack-managed" — for each:
 *      • if `row[f]` deep-equals `row.pristineSnapshot?.[f]` → user hasn't
 *        touched it → write `overlay[f]` (may be undefined when the new
 *        pack version dropped the field).
 *      • else → diverged → preserve, record in `preserved[]`.
 *   3. When `row.pristineSnapshot` is undefined (legacy v48 clone), every
 *      pack-managed field falls into the overwrite bucket because we have
 *      no baseline to compare against. The dialog renders a "no baseline"
 *      warning so the user knows their edits will be clobbered.
 *
 * The returned `nextSnapshot` is the snapshot to persist alongside the
 * update — every pack-managed field on the latest overlay character,
 * deep-copied via JSON round-trip so subsequent overlay mutations don't
 * leak through the reference.
 */

import type { Character, PackPristineSnapshot, SendOptions } from "@/lib/claude/types"
import type {
  PluginCharacterAvatarImage,
  PluginCharacterDef,
  PluginCharacterPersona,
  PluginCharacterVoiceProfile,
} from "@/types/plugin/plugin-character-pack"
import type { PluginRuntimeProfile } from "@/types/plugin"

/**
 * Fields that belong to the user and never get overwritten by Apply Update.
 * The runtime-attribution columns (`sourcePluginId`, `sourcePackId`,
 * `clonedFromPackCharacterId`, `packVersionAtClone`, `pristineSnapshot`)
 * are also user-owned in the sense that the caller mutates them
 * separately — they're not surfaced in `preserved[]` because they were
 * never on the table for overwrite.
 */
export const USER_OWNED_CHARACTER_FIELDS: ReadonlySet<keyof Character> = new Set<keyof Character>([
  "id",
  "name",
  "isBuiltIn",
  "twinId",
  "twinSettings",
  "accountIdOverride",
  "workingDir",
  "bareMode",
  "debugMode",
  "briefMode",
  "sandboxEnabled",
  "maxThinkingTokens",
  "embeddingProviderId",
  "disablePluginTools",
  "enableBuiltInSkills",
  "createdAt",
  "updatedAt",
])

/** Order matters only for `preserved[]` UI rendering — newest fields last. */
const PACK_MANAGED_FIELDS = [
  "systemPrompt",
  "description",
  "avatarColor",
  "avatarEmoji",
  "model",
  "providerId",
  "permissionMode",
  "allowedTools",
  "disallowedTools",
  "mcpServerIds",
  "skillIds",
  "pluginSkillIds",
  "enableComputerUse",
  "computerUseSettings",
  "sandboxTier",
  "a2uiEnabled",
  "a2uiCatalogId",
  "platformDefaults",
  "availableOnPlatforms",
  "avatarImage",
  "persona",
  "voiceProfile",
] as const satisfies ReadonlyArray<keyof PackPristineSnapshot>

export type PackManagedField = (typeof PACK_MANAGED_FIELDS)[number]

export const PACK_MANAGED_FIELD_LIST: ReadonlyArray<PackManagedField> = PACK_MANAGED_FIELDS

/**
 * Per-field diff result. Surfaced by the dialog as one row each.
 */
export interface PackUpdateFieldChange {
  field: PackManagedField
  /** Value the row currently holds (Dexie). */
  current: unknown
  /** Value the latest overlay character holds. */
  next: unknown
}

/**
 * Diff result. `overwrites` is a `Partial<Character>` ready to splat into
 * `dexie.update`; `preserved` is the list of fields the user changed
 * (and that we're therefore leaving alone). `nextSnapshot` is the
 * snapshot to persist when the user confirms.
 */
export interface PackUpdateDiff {
  overwrites: Partial<Character>
  preserved: PackUpdateFieldChange[]
  willOverwrite: PackUpdateFieldChange[]
  nextSnapshot: PackPristineSnapshot
  /** True when `row.pristineSnapshot` was missing — we can't tell user edits apart. */
  noBaseline: boolean
}

/**
 * Build the snapshot we'd persist after applying this update. Mirrors
 * the `PACK_MANAGED_FIELDS` list so it stays in sync by construction.
 */
export function buildPristineSnapshot(overlay: PluginCharacterDef): PackPristineSnapshot {
  return {
    systemPrompt: overlay.systemPrompt,
    description: overlay.description,
    avatarColor: overlay.avatarColor,
    avatarEmoji: overlay.avatarEmoji,
    model: overlay.model,
    providerId: overlay.providerId,
    permissionMode: overlay.permissionMode as SendOptions["permissionMode"],
    allowedTools: cloneArray(overlay.allowedTools),
    disallowedTools: cloneArray(overlay.disallowedTools),
    mcpServerIds: cloneArray(overlay.mcpServerIds),
    skillIds: cloneArray(overlay.skillIds),
    pluginSkillIds: cloneArray(overlay.pluginSkillIds),
    enableComputerUse: overlay.enableComputerUse,
    computerUseSettings: cloneJson(overlay.computerUseSettings) as Character["computerUseSettings"],
    sandboxTier: overlay.sandboxTier,
    a2uiEnabled: overlay.a2uiEnabled,
    a2uiCatalogId: overlay.a2uiCatalogId,
    platformDefaults: cloneJson(overlay.platformDefaults) as Character["platformDefaults"],
    availableOnPlatforms: cloneArray(overlay.availableOnPlatforms) as
      | PluginRuntimeProfile[]
      | undefined,
    avatarImage: cloneJson(overlay.avatarImage) as PluginCharacterAvatarImage | undefined,
    persona: cloneJson(overlay.persona) as PluginCharacterPersona | undefined,
    voiceProfile: cloneJson(overlay.voiceProfile) as PluginCharacterVoiceProfile | undefined,
  }
}

export function diffPackUpdate(row: Character, overlay: PluginCharacterDef): PackUpdateDiff {
  const nextSnapshot = buildPristineSnapshot(overlay)
  const baseline = row.pristineSnapshot
  const noBaseline = baseline === undefined

  const overwrites: Partial<Character> = {}
  const preserved: PackUpdateFieldChange[] = []
  const willOverwrite: PackUpdateFieldChange[] = []

  for (const field of PACK_MANAGED_FIELDS) {
    if (USER_OWNED_CHARACTER_FIELDS.has(field as keyof Character)) continue
    const current = (row as unknown as Record<string, unknown>)[field]
    const next = (nextSnapshot as unknown as Record<string, unknown>)[field]

    // No-op fast path: row matches the next-snapshot byte-for-byte. No
    // overwrite, no preserve — the field already reflects the latest pack.
    if (deepEqual(current, next)) continue

    if (noBaseline) {
      // Without a baseline we cannot tell user edits from outdated copies;
      // the dialog warns and we surface everything as a will-overwrite.
      overwrites[field as keyof Character] = next as never
      willOverwrite.push({ field, current, next })
      continue
    }

    const baselineValue = (baseline as Record<string, unknown>)[field]
    if (deepEqual(current, baselineValue)) {
      // User hasn't touched it since the last clone / apply-update; safe
      // to overwrite from the latest overlay.
      overwrites[field as keyof Character] = next as never
      willOverwrite.push({ field, current, next })
    } else {
      // User changed this field after the last snapshot — preserve.
      preserved.push({ field, current, next })
    }
  }

  return { overwrites, preserved, willOverwrite, nextSnapshot, noBaseline }
}

function cloneArray<T>(arr: ReadonlyArray<T> | undefined): T[] | undefined {
  if (arr === undefined) return undefined
  return arr.slice() as T[]
}

function cloneJson<T>(value: T): T {
  if (value === undefined) return undefined as T
  return JSON.parse(JSON.stringify(value)) as T
}

/**
 * Stable structural equality. Suitable for the scalar + array + plain-object
 * shapes pack-managed fields take. Uses a sorted-key serialiser so we don't
 * mistake `{ a: 1, b: 2 }` for a different value than `{ b: 2, a: 1 }`.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined) return false
  if (a === null || b === null) return false
  return stableStringify(a) === stableStringify(b)
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]"
  }
  const keys = Object.keys(value as Record<string, unknown>).sort()
  return (
    "{" +
    keys
      .map((k) => JSON.stringify(k) + ":" + stableStringify((value as Record<string, unknown>)[k]))
      .join(",") +
    "}"
  )
}
