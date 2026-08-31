// Hand-written facade over the generated built-in skills catalog.
//
// The data lives in `built-in-catalog.generated.ts` (codegen from
// `skills/built-in/*/SKILL.md` — see scripts/build/build-builtin-skills.mjs).
// This module adds the typed surface ids and the small helpers the rest of the
// app uses, so consumers never reach into the generated file directly.

import {
  BUILT_IN_SKILL_CAPABILITY_IDS,
  BUILT_IN_SKILL_CATALOG,
  type BuiltInSkillCapabilityId,
  type BuiltInSkillCapabilityRequirement,
  type BuiltInSkillCatalogEntry,
  type BuiltInSkillDelivery,
  type BuiltInSkillResource,
  type BuiltInSkillResourceDescriptor,
  type BuiltInSkillTriggerFacts,
} from "@/generated/built-in-skills/built-in-catalog.generated"

export { BUILT_IN_SKILL_CAPABILITY_IDS, BUILT_IN_SKILL_CATALOG }
export type {
  BuiltInSkillCapabilityId,
  BuiltInSkillCapabilityRequirement,
  BuiltInSkillCatalogEntry,
  BuiltInSkillDelivery,
  BuiltInSkillResource,
  BuiltInSkillResourceDescriptor,
  BuiltInSkillTriggerFacts,
}

/**
 * Agent surfaces a built-in skill can auto-activate on. Mirrors the
 * `metadata.triggers.surfaces` facts authored in SKILL.md frontmatter. Delivery
 * remains an orthogonal descriptor; a catalog or explicit skill can have no
 * surface without implying that it should be globally injected.
 */
export type SurfaceId =
  "im-connector" | "computer-use" | "workflow-editor" | "agent-team" | "digital-twin" | "goal-loop"

/** Dexie row-id prefix for a seeded built-in skill (matches the legacy 5). */
export const BUILTIN_SKILL_ID_PREFIX = "skill_builtin_"
export const BUILTIN_SKILL_CANONICAL_PREFIX = "builtin:"

export interface BuiltInSkillIdentity {
  bundleId: string
  canonicalId: string
  storageId: string
}

/** Stable Dexie row id for a catalog entry, e.g. `skill_builtin_im_auto_reply`. */
export function builtinSkillId(entry: BuiltInSkillCatalogEntry): string {
  return BUILTIN_SKILL_ID_PREFIX + entry.id.replace(/-/g, "_")
}

/** Portable canonical id for a catalog entry, e.g. `builtin:im-auto-reply`. */
export function canonicalBuiltinSkillId(entry: BuiltInSkillCatalogEntry): string {
  return entry.canonicalId
}

/**
 * Resolve every public alias for a seeded built-in to one identity. This is
 * deliberately catalog-backed: an arbitrary `builtin:*` string must never be
 * accepted merely because it has the right prefix.
 */
export function resolveBuiltinSkillIdentity(alias: string): BuiltInSkillIdentity | undefined {
  const key = alias.trim()
  if (!key) return undefined
  const entry = BUILT_IN_SKILL_CATALOG.find(
    (candidate) =>
      candidate.id === key ||
      canonicalBuiltinSkillId(candidate) === key ||
      builtinSkillId(candidate) === key
  )
  if (!entry) return undefined
  return {
    bundleId: entry.id,
    canonicalId: canonicalBuiltinSkillId(entry),
    storageId: builtinSkillId(entry),
  }
}

/** Look up a catalog entry by its bundle id (folder name), e.g. `workflow-authoring`. */
export function getCatalogSkill(id: string): BuiltInSkillCatalogEntry | undefined {
  const identity = resolveBuiltinSkillIdentity(id)
  return identity
    ? BUILT_IN_SKILL_CATALOG.find((entry) => entry.id === identity.bundleId)
    : undefined
}
