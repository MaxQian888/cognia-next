/**
 * Plugin Skill Definitions
 *
 * Plugins contributing the `skills` capability ship agent skills through
 * their manifest. The discriminated `source` union lets a plugin pull
 * skill content from a local folder bundled with the plugin, reference an
 * Anthropic-managed container skill by id, or inline the markdown body
 * directly — covering the three sourcing modes the runtime supports.
 */

export type PluginSkillSource =
  | { kind: "local-folder"; path: string }
  | { kind: "anthropic-managed"; containerSkillId: string; version?: string }
  | { kind: "inline"; markdown: string }

export interface PluginSkillDef {
  /** Unique id within the plugin. */
  id: string
  /** Display name shown in the skill picker. */
  name: string
  /** One-line description. */
  description: string
  /** Where the skill content comes from. */
  source: PluginSkillSource
  /**
   * Visibility scope:
   * - "character": only appears in character-level skill picker
   * - "team":      only in team skill picker
   * - "global":    shows in every picker but never auto-attaches
   */
  scope?: "character" | "team" | "global"
  /** When set, the plugin pre-attaches the skill to these character ids on enable. */
  attachToCharacterIds?: string[]
  /** Optional allow-list of tools the skill needs. */
  allowedTools?: string[]
}
