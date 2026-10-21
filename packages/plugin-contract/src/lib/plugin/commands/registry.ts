/**
 * The plugin contract's share of `lib/plugin/commands/registry.ts`, which re-exports these.
 */

export type CommandHandler = (...args: unknown[]) => unknown | Promise<unknown>

export interface CommandRegistration {
  /** Canonical command identifier, e.g. `"editor.action.formatDocument"`. */
  id: string
  /** Display title (used by command palette + keybinding sheets). */
  title?: string
  /** Optional category for command-palette grouping. */
  category?: string
  /** Owning plugin id. `null` for cognia-native commands. */
  pluginId: string | null
  /** Optional `when` clause (parsed by the consumer — we just store it). */
  when?: string
  /** The handler function. */
  handler: CommandHandler
}

export type CommandRegistryEventType = "register" | "unregister"

export interface CommandRegistryEvent {
  type: CommandRegistryEventType
  id: string
  pluginId: string | null
}

export type CommandRegistryListener = (event: CommandRegistryEvent) => void
