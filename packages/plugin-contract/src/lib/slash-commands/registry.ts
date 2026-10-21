/**
 * The plugin contract's share of `lib/slash-commands/registry.ts`, which re-exports these.
 */
export interface SlashCommandHandler {
  (args: string, ctx?: SlashCommandContext): Promise<SlashCommandResult> | SlashCommandResult
}

export interface SlashCommandContext {
  /** Cooperative cancellation supplied by the invoking host, when supported. */
  signal?: AbortSignal
  /** Report progress from 0 to 1 with an optional status message. */
  reportProgress?: (progress: number, message?: string) => void

  /** Current chat session id (if any). */
  sessionId?: string
  /** Current character id (if any). */
  characterId?: string
  /** Surface invocation supplied by the unified quick-action dispatcher. */
  quickAction?: import("../../types/plugin").PluginQuickActionInvocation
}

export interface SlashCommandResult {
  /** Optional message inserted into the chat as the command's response. */
  message?: string
  /** Free-form payload for callers that want richer dispatch. */
  payload?: Record<string, unknown>
}

export interface SlashCommandDefinition {
  /** Stable id, e.g., `"git-tools.status"`. */
  id: string
  /** User-facing name shown in the command palette. */
  name: string
  /** Description shown in the palette / autocomplete. */
  description?: string
  /**
   * Plugin commands only: a key into the owning plugin's locale bundle,
   * resolved by the picker for the UI language. `description` is the fallback.
   */
  descriptionKey?: string
  /** Optional keyboard shortcut hint (purely cosmetic in the UI). */
  shortcut?: string | null
  /** The function invoked when the user runs the command. */
  handler: SlashCommandHandler
  /** Origin tag — set by the plugin manager when contributed. */
  source?: "builtin" | "plugin"
  /** Plugin id when `source === "plugin"`. */
  pluginId?: string
  /**
   * Grouping key consumed by surfaces that list commands by section — most
   * notably the tray's "All Commands ▶" submenu. Free-form; the tray uses
   * the canonical buckets `chat | diagnostics | system | goal | template |
   * help | plugins`. Defaults to `"chat"` when absent.
   */
  category?: string
}

export interface RegisterSlashCommandResult {
  /** True when the registration replaced an existing entry with the same id. */
  replaced: boolean
}
