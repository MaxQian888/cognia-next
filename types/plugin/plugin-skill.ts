/**
 * Plugin Skill Definitions
 *
 * Plugins contributing the `skills` capability ship agent skills through
 * their manifest. The discriminated `source` union covers five sourcing
 * modes: a plain SKILL.md folder, an Anthropic-managed container skill,
 * inline markdown, a bundle folder with sibling scripts/references/assets,
 * or a zipped bundle archive extracted at enable time.
 *
 * `local-folder` and `local-bundle` differ only in expectations — the
 * folder variant has historically been SKILL.md-only and stays
 * backward-compatible while now also surfacing sibling resources when they
 * exist; the bundle variant declares the resource-bearing layout
 * explicitly so the loader treats missing siblings as a soft warning
 * instead of silence. `archive` points at a `.zip` matching the Anthropic
 * skill-creator / Codex CLI superset format.
 */

export type PluginSkillSource =
  | { kind: "local-folder"; path: string }
  | { kind: "anthropic-managed"; containerSkillId: string; version?: string }
  | { kind: "inline"; markdown: string }
  | { kind: "local-bundle"; path: string }
  | { kind: "archive"; path: string }

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
