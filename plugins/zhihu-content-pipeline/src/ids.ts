/**
 * Shared id helpers for the Zhihu Content Pipeline plugin.
 *
 * Centralises the plugin id and the namespacing conventions the host expects
 * (mirrors `cognia-backend-refactor/src/ids.ts`):
 *  - Plugin skills live in the skill-registry under their verbatim `def.id`,
 *    so authors self-namespace as `<pluginId>:<name>`. Characters reference
 *    them via `pluginSkillIds`.
 *  - Pack characters resolve at runtime as
 *    `cognia-pack:<pluginId>:<packId>:<localId>` (see
 *    `lib/db/characters.ts:resolveCharacterById`).
 *  - Custom workflow node kinds are auto-prefixed `<pluginId>.<kind>` by
 *    `lib/plugin/core/context.ts:prefixKind`, so templates reference the
 *    prefixed form.
 *  - MCP server presets carry a plain id; we prefix `zhihu-` to avoid
 *    colliding with the static `MCP_PRESETS` gallery ids.
 */

export const PLUGIN_ID = "zhihu-content-pipeline"

/** Character pack id — combined with PLUGIN_ID + localId to form the runtime id. */
export const ROLE_PACK_ID = "zhihu-roles"

/** Skill registry id for a plugin-contributed skill (used in `pluginSkillIds`). */
export function packSkillId(name: string): string {
  return `${PLUGIN_ID}:${name}`
}

/** Runtime character id for a role, as the host projects pack characters. */
export function roleCharacterId(localId: string): string {
  return `cognia-pack:${PLUGIN_ID}:${ROLE_PACK_ID}:${localId}`
}

/** MCP server preset id (kebab-case, plugin-prefixed to avoid gallery collisions). */
export function mcpPresetId(name: string): string {
  return `${PLUGIN_ID}-${name}`
}

/** Runtime-prefixed workflow node kind (the host prefixes `<pluginId>.`). */
export function nodeKind(localKind: string): string {
  return `${PLUGIN_ID}.${localKind}`
}
