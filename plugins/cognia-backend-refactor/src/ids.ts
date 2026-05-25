/**
 * Shared id helpers for the Backend Refactor plugin.
 *
 * Centralises the plugin id and the namespacing conventions the host expects:
 *  - Plugin skills are stored in the skill-registry under their verbatim
 *    `def.id` (identity keyFn), so authors self-namespace as
 *    `<pluginId>:<name>`. Characters reference them via `pluginSkillIds`.
 *  - Plugin subagents resolve at `<pluginId>:<id>` (see
 *    `lib/claude/agents/subagents/index.ts:resolveAllSubagents`).
 *  - Custom workflow node kinds are auto-prefixed `<pluginId>.<kind>` by
 *    `lib/plugin/core/context.ts:prefixKind`, so templates reference the
 *    prefixed form.
 */

export const PLUGIN_ID = "cognia-backend-refactor"

/** Skill registry id for a plugin-contributed skill (used in `pluginSkillIds`). */
export function packSkillId(name: string): string {
  return `${PLUGIN_ID}:${name}`
}

/** Runtime subagent id, as `resolveAllSubagents` namespaces plugin subagents. */
export function subagentRuntimeId(localId: string): string {
  return `${PLUGIN_ID}:${localId}`
}

/** Runtime-prefixed workflow node kind (the host prefixes `<pluginId>.`). */
export function nodeKind(localKind: string): string {
  return `${PLUGIN_ID}.${localKind}`
}
