// Hand-written facade over the generated built-in skills catalog.
//
// The data lives in `built-in-catalog.generated.ts` (codegen from
// `skills/built-in/*/SKILL.md` — see scripts/build/build-builtin-skills.mjs).
// This module adds the typed surface ids and the small helpers the rest of the
// app uses, so consumers never reach into the generated file directly.

import {
  BUILT_IN_SKILL_CATALOG,
  type BuiltInSkillCatalogEntry,
  type BuiltInSkillResource,
} from "./built-in-catalog.generated"

export { BUILT_IN_SKILL_CATALOG }
export type { BuiltInSkillCatalogEntry, BuiltInSkillResource }

/**
 * Agent surfaces a built-in skill can auto-activate on. Mirrors the
 * `metadata.surface` values authored in the SKILL.md frontmatter. A skill with
 * no surface (e.g. ocr / web-research) is opt-in only — never auto-activated.
 */
export type SurfaceId =
  "im-connector" | "computer-use" | "workflow-editor" | "agent-team" | "digital-twin" | "goal-loop"

/** Dexie row-id prefix for a seeded built-in skill (matches the legacy 5). */
export const BUILTIN_SKILL_ID_PREFIX = "skill_builtin_"

/** Stable Dexie row id for a catalog entry, e.g. `skill_builtin_im_auto_reply`. */
export function builtinSkillId(entry: BuiltInSkillCatalogEntry): string {
  return BUILTIN_SKILL_ID_PREFIX + entry.id.replace(/-/g, "_")
}

/** Look up a catalog entry by its bundle id (folder name), e.g. `workflow-authoring`. */
export function getCatalogSkill(id: string): BuiltInSkillCatalogEntry | undefined {
  return BUILT_IN_SKILL_CATALOG.find((e) => e.id === id)
}
