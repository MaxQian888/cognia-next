/**
 * Plugin SDK — `slash-command` capability surface.
 *
 * Re-exports the unified slash-command registry a plugin uses to contribute
 * `/commands` at activation time. The registry itself
 * (`lib/slash-commands/registry.ts`) is the single source of truth for every
 * third-party command; the host's own composer dispatch path
 * (`lib/slash-commands/builtin.ts`) is deliberately NOT re-exported — it
 * carries a context object (`activeSessionId`, `pushSystemMessage`,
 * `openSettings`, …) that only the chat surface can supply.
 *
 * A plugin registers from inside `activate(ctx)` and the plugin manager bulk-
 * removes everything it contributed on disable via
 * `unregisterCommandsByPlugin(pluginId)` — which is also the cleanup a plugin's
 * own tests should call instead of reaching for host-private reset helpers.
 *
 * Note the deliberate omission of `seedBuiltinSlashCommands` and
 * `__resetSlashCommandsForTesting`: both mutate the host's shared registry in
 * ways a plugin has no business doing.
 */

export {
  dispatchSlashCommand,
  getSlashCommand,
  getSlashCommandsVersion,
  listSlashCommands,
  registerSlashCommand,
  subscribeSlashCommands,
  unregisterSlashCommand,
  // Renamed on the way out: the host has a SECOND `listCommandsByPlugin` (the
  // plugin-command registry on `./command`), and two identically-named
  // registry readers in one SDK is a trap an author only finds at runtime.
  listCommandsByPlugin as listSlashCommandsByPlugin,
  unregisterCommandsByPlugin as unregisterSlashCommandsByPlugin,
} from "@/lib/slash-commands/registry"

export type {
  RegisterSlashCommandResult,
  SlashCommandContext,
  SlashCommandDefinition,
  SlashCommandHandler,
  SlashCommandResult,
} from "@/lib/slash-commands/registry"
