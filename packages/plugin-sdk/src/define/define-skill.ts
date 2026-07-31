/**
 * Plugin SDK helper for the `skills` capability (unblocked in M1·T4).
 *
 * Pure typesafety pass-through — wrapping a manifest entry in
 * `defineSkill()` gives plugin authors autocomplete and a compile-time
 * check that the def shape matches `PluginSkillDef`. Particularly helpful
 * for narrowing the discriminated `source` union (`local-folder` /
 * `anthropic-managed` / `inline`) at authoring time.
 *
 * Usage:
 *   const codeReview = defineSkill({
 *     id: "code-review",
 *     name: "Code Review",
 *     description: "Reviews code changes",
 *     source: { kind: "local-folder", path: "./skills/code-review" },
 *   })
 *
 * Part of the plugin-first Computer Use plan (M1·T6).
 */

import type { PluginSkillDef } from "@/types/plugin/plugin-skill"

export function defineSkill(def: PluginSkillDef): PluginSkillDef {
  return def
}
