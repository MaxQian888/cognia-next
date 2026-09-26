// Agent variants: one agent kind, several configurations.
//
// A variant is a `Character` row linked to a base agent. It owns only the
// profile fields its author changed; every other profile field follows the
// base, so fixing the base's prompt or adding a skill to it reaches every
// variant. Duplicating an agent, by contrast, makes a detached copy that
// never hears about the original again.
//
// The row still stores a full, materialized profile (the effective values as
// of its last save). Readers that load the raw row keep seeing a complete
// agent, and when the base can no longer be resolved (deleted plugin pack,
// cycle, chain too deep) the variant falls back to that snapshot instead of
// silently losing its prompt and tools.
//
// Row fields — identity, presentation, provenance — never come from the base:
// a variant has its own name and avatar, and pack lineage describes the row,
// not the configuration.

import type { Character } from "./index"

/** Fields that describe the row itself and are never inherited from a base. */
export const CHARACTER_ROW_FIELDS = [
  "id",
  "name",
  "description",
  "avatarColor",
  "avatarEmoji",
  "avatarImage",
  "createdAt",
  "updatedAt",
  "isBuiltIn",
  "variant",
  "sourcePluginId",
  "sourcePackId",
  "clonedFromPackCharacterId",
  "packVersionAtClone",
  "pristineSnapshot",
] as const satisfies readonly (keyof Character)[]

export type CharacterRowField = (typeof CHARACTER_ROW_FIELDS)[number]

/** Every field a variant can either inherit from its base or own. */
export type CharacterProfileField = Exclude<keyof Character, CharacterRowField>

/** Link from a variant row to the agent it specialises. */
export interface CharacterVariantLink {
  /** Id of the base agent: a Dexie row or a plugin-pack overlay id. */
  baseId: string
  /** Profile fields this variant owns. Every other profile field follows the base. */
  ownFields: CharacterProfileField[]
}

/** Longest base chain resolved before falling back to the stored snapshot. */
export const MAX_VARIANT_DEPTH = 4

const ROW_FIELDS: ReadonlySet<string> = new Set(CHARACTER_ROW_FIELDS)

export function isCharacterProfileField(key: string): key is CharacterProfileField {
  return !ROW_FIELDS.has(key)
}

function profileEntries(character: Partial<Character>): Array<[CharacterProfileField, unknown]> {
  const entries: Array<[string, unknown]> = Object.entries(character)
  return entries.filter(
    (entry): entry is [CharacterProfileField, unknown] =>
      isCharacterProfileField(entry[0]) && entry[1] !== undefined
  )
}

/**
 * The effective agent for a variant: the base's profile, then the variant's
 * own fields, then the variant's row fields. An owned field whose value is
 * `undefined` clears the base's value rather than inheriting it.
 */
export function applyVariantOverlay(variant: Character, base: Character): Character {
  const out: Record<string, unknown> = {}
  for (const [key, value] of profileEntries(base)) out[key] = value
  for (const key of variant.variant?.ownFields ?? []) {
    const value = (variant as unknown as Record<string, unknown>)[key]
    if (value === undefined) delete out[key]
    else out[key] = value
  }
  for (const key of CHARACTER_ROW_FIELDS) {
    const value = (variant as unknown as Record<string, unknown>)[key]
    if (value !== undefined) out[key] = value
  }
  return out as unknown as Character
}

/** Structural equality over JSON-shaped values; `undefined` equals absent. */
export function sameProfileValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined || a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, index) => sameProfileValue(item, b[index]))
  }
  if (typeof a === "object" && typeof b === "object") {
    const left = a as Record<string, unknown>
    const right = b as Record<string, unknown>
    const keys = new Set([...Object.keys(left), ...Object.keys(right)])
    for (const key of keys) {
      if (!sameProfileValue(left[key], right[key])) return false
    }
    return true
  }
  return false
}

/**
 * The profile fields an edit owns: every field whose edited value differs from
 * the base's effective value. A field edited back to the base's value returns
 * to following the base. Sorted so the stored list is stable across saves.
 */
export function diffVariantOwnFields(
  base: Partial<Character>,
  edited: Partial<Character>
): CharacterProfileField[] {
  const keys = new Set<CharacterProfileField>()
  for (const [key] of profileEntries(base)) keys.add(key)
  for (const [key] of profileEntries(edited)) keys.add(key)
  // A field the edit cleared is present with `undefined`; it differs from a
  // base that sets it.
  for (const key of Object.keys(edited)) {
    if (isCharacterProfileField(key)) keys.add(key)
  }
  const baseRecord = base as Record<string, unknown>
  const editedRecord = edited as Record<string, unknown>
  return [...keys].filter((key) => !sameProfileValue(baseRecord[key], editedRecord[key])).sort()
}

/** A variant's profile materialized from its effective agent, for storage. */
export function materializeVariantProfile(effective: Character): Partial<Character> {
  return Object.fromEntries(profileEntries(effective)) as Partial<Character>
}
