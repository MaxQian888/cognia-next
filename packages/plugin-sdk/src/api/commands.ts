/**
 * Plugin SDK, `commands` capability surface.
 *
 * The runtime half of the slash-command story. `@cognia/plugin-sdk/api/slash-command`
 * publishes the registry's own vocabulary and `defineCommand` for the
 * declarative `manifest.commands[]` path. This module publishes the types of
 * `ctx.commands`, which a plugin uses when its command set is only known once
 * it has talked to something.
 */

export type {
  PluginCommandsAPI,
  PluginCustomCommand,
  PluginCustomCommandWriteInput,
  PluginSlashCommandInput,
  PluginSlashCommandSummary,
} from "@/lib/plugin/api/commands-api"

export type {
  ProjectCommandDir,
  WorkspaceCustomCommand,
} from "@/lib/slash-commands/custom-workspace"

export type { SlashCommandContext, SlashCommandResult } from "@/lib/slash-commands/registry"
