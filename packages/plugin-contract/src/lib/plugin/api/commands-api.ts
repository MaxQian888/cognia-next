/**
 * The plugin contract's share of `lib/plugin/api/commands-api.ts`, which re-exports these.
 */
import type { ProjectCommandDir } from "../../slash-commands/custom-workspace"
import type { SlashCommandContext, SlashCommandResult } from "../../slash-commands/registry"

/** What a plugin hands `registerSlashCommand`. */
export interface PluginSlashCommandInput {
  /** Short id, namespaced to `<pluginId>.<id>` by the host. */
  id: string
  /** Shown in the picker. Defaults to the short id. */
  name?: string
  description?: string
  /** Extra typeable names for the same handler. */
  aliases?: string[]
  /** Grouping bucket used by the tray and settings lists. Defaults to "plugins". */
  category?: string
  handler(
    args: string,
    context?: SlashCommandContext
  ): Promise<SlashCommandResult | void> | SlashCommandResult | void
}

/** A registry entry as a plugin may see it, with the handler removed. */
export interface PluginSlashCommandSummary {
  id: string
  name: string
  description?: string
  source?: "builtin" | "plugin"
  pluginId?: string
  category?: string
}

/** One of the user's markdown command files. */
export interface PluginCustomCommand {
  name: string
  description: string
  scope: "user" | "project"
  argumentHint?: string
  model?: string
  allowedTools?: string[]
  /** The prompt body, with its `$1..$9` / `$ARGUMENTS` placeholders intact. */
  template?: string
  /** Where the file lives. Absolute on the desktop, repo-relative otherwise. */
  filePath?: string
  /** Directory it was found in, when the host said. */
  originDir?: string
}

export interface PluginCustomCommandWriteInput {
  name: string
  /** Defaults to "project", the scope a paired browser or phone can also write. */
  scope?: "user" | "project"
  body: string
  description?: string
  argumentHint?: string
  allowedTools?: string[]
  model?: string
  /** Project directory to write into. Defaults to the file's own, then `.claude/commands`. */
  dir?: ProjectCommandDir
  /** Workspace root. Defaults to the folder the user has open. */
  cwd?: string
}

export interface PluginCommandsAPI {
  /**
   * Register a slash command for as long as this plugin is active. Returns a
   * disposer. The registration is also owned by the plugin's lifecycle scope,
   * so forgetting to call it leaks nothing.
   */
  registerSlashCommand(input: PluginSlashCommandInput): () => void
  /** Remove one of this plugin's own registrations. Ignores anything else. */
  unregisterSlashCommand(id: string): boolean
  /** Every command in the unified registry, built-in and plugin alike. */
  listSlashCommands(): PluginSlashCommandSummary[]
  /** The user's markdown command files. */
  listCustomCommands(options?: { cwd?: string }): Promise<PluginCustomCommand[]>
  getCustomCommand(
    name: string,
    options?: { cwd?: string }
  ): Promise<PluginCustomCommand | undefined>
  /** Create or overwrite a markdown command file. Prompts for consent. */
  saveCustomCommand(input: PluginCustomCommandWriteInput): Promise<{ path: string }>
  /** Delete a markdown command file. Prompts for consent. Already-gone is success. */
  deleteCustomCommand(args: {
    name: string
    scope?: "user" | "project"
    cwd?: string
    dir?: ProjectCommandDir
  }): Promise<void>
}
