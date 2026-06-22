/**
 * Plugin SDK - `command` capability surface.
 *
 * Re-exports the manifest authoring helper and the unified host command bus
 * used by Cognia-native and VS Code-compatible command contributions.
 */

export { defineCommand } from "../define/define-command"

export {
  CommandNotFoundError,
  executeCommand,
  getCommand,
  getCommands,
  listCommandsByPlugin,
  registerCommand,
  subscribeCommandRegistry,
  unregisterCommand,
  unregisterCommandsByPlugin,
} from "@/lib/plugin/commands/registry"

export type {
  CommandHandler,
  CommandRegistration,
  CommandRegistryEvent,
  CommandRegistryListener,
} from "@/lib/plugin/commands/registry"

export type { PluginCommand, PluginManifestCommandDef } from "@/types/plugin"
