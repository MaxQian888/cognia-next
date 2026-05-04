/**
 * @deprecated Phase 3 of the ClaudeCode 完整化 plan moved this registry to
 * `@/lib/slash-commands/registry`. This file remains as a thin re-export so
 * existing plugin-manager imports keep working for one release cycle. New
 * code MUST import from `@/lib/slash-commands/registry`.
 */
export {
  type SlashCommandHandler,
  type SlashCommandContext,
  type SlashCommandResult,
  type SlashCommandDefinition,
  type RegisterSlashCommandResult,
  registerSlashCommand,
  unregisterSlashCommand,
  unregisterCommandsByPlugin,
  getSlashCommand,
  listSlashCommands,
  listCommandsByPlugin,
  dispatchSlashCommand,
  __resetSlashCommandsForTesting,
} from "@/lib/slash-commands/registry"
