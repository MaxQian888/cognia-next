/**
 * The plugin contract's share of `lib/i18n/plugin-i18n-registry.ts`, which re-exports these.
 */
export type LocaleCode = string

/**
 * One plugin's message contribution: a per-locale flat string map. Nested
 * paths use dot notation (e.g., `"plugin.git.tools.status.label"`).
 */
export interface PluginI18nBundle {
  /** Plugin id contributing the messages. */
  pluginId: string
  /** Map of locale code → flat string map. */
  messages: Partial<Record<LocaleCode, Record<string, string>>>
}
