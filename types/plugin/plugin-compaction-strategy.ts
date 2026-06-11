/**
 * Plugin Compaction Strategy contract (`compaction-strategy` capability).
 *
 * Opens conversation-compaction tuning to plugins. The built-in strategy
 * (`lib/claude/compact-instructions.ts`) composes the canonical summary prompt
 * + the user's focus; a plugin can contribute an alternative strategy by
 * shipping a `compactionStrategies[]` manifest entry.
 *
 * A strategy is DECLARATIVE (the same posture as `balance-adapter`): it carries
 * a summary prompt and/or threshold knobs — no executable entry/export. This is
 * deliberate: the actual summarization runs in the sidecar (which cannot import
 * `lib/`), so a strategy only contributes the prompt + numeric config that
 * `resolveSendOptions` threads into `SendOptions.compaction`. There is no
 * per-turn renderer↔sidecar callback.
 *
 * Consumed by `resolveCompactionStrategy` (`lib/plugin/registries/
 * compaction-strategy-registry.ts`), which checks plugin strategies before the
 * built-in default.
 */

export interface PluginCompactionStrategyDef {
  /** Stable registry id (registered verbatim, e.g. `<pluginId>:<strategy>`). */
  id: string
  /** Display name for the settings strategy picker + capability summary. */
  label?: string
  /**
   * Full summarization system prompt this strategy uses. When omitted the
   * resolver falls back to the canonical conversation-summary prompt. The
   * user's `focus` is appended on top of whichever prompt is chosen.
   */
  summaryPrompt?: string
  /** Override for the number of most-recent turns kept verbatim. */
  keepRecent?: number
  /** Override for the window fraction (0..1) at which auto-compaction triggers. */
  fraction?: number
}
