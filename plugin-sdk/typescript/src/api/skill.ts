/**
 * Plugin SDK — `skills` capability surface.
 *
 * Re-exports the `defineSkill()` authoring helper and the dynamic skill
 * registry plugins use to contribute agent skills at activation time.
 *
 * Sources:
 *  - `lib/plugin/sdk/define-skill.ts`
 *  - `lib/plugin/registries/skill-registry.ts`
 *  - `types/plugin/plugin-skill.ts`
 *
 * Plugin authors call `defineSkill()` in their manifest builder for
 * autocomplete + compile-time shape checks, then either declare the skill
 * statically in the manifest's `skills` array or call `registerSkill()`
 * inside `activate(ctx)` for dynamic registration.
 */

export { defineSkill } from "@/lib/plugin/sdk/define-skill"

export {
  registerSkill,
  unregisterSkillById,
  unregisterSkillsByPlugin,
  getSkill,
  getSkillEntry,
  listSkillIds,
  listSkillEntries,
} from "@/lib/plugin/registries/skill-registry"

export type { PluginSkillDef, PluginSkillSource } from "@/types/plugin/plugin-skill"
