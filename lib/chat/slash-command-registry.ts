// Slash-command registry (§E new module).
//
// Cognia-next does not currently have a slash-command parser in its chat
// input — Cognia's plugin manager imports `@/lib/chat/slash-command-registry`
// to register and look up commands. This module provides that surface so
// the manager port (Task #13) can compile and so plugins contributing
// slash commands have a real registry to write into.
//
// The registry is intentionally tiny: a Map of command id → handler,
// plus origin metadata (`source: "builtin" | "plugin"`, `pluginId`) so the
// manager can bulk-unregister everything a plugin contributed when the
// plugin is disabled. Wiring this registry into the chat input UI is a
// separate concern (deferred until the chat composer is touched again).

export interface SlashCommandHandler {
  (args: string, ctx?: SlashCommandContext): Promise<SlashCommandResult> | SlashCommandResult
}

export interface SlashCommandContext {
  /** Current chat session id (if any). */
  sessionId?: string
  /** Current character id (if any). */
  characterId?: string
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
  /** Optional keyboard shortcut hint (purely cosmetic in the UI). */
  shortcut?: string | null
  /** The function invoked when the user runs the command. */
  handler: SlashCommandHandler
  /** Origin tag — set by the plugin manager when contributed. */
  source?: "builtin" | "plugin"
  /** Plugin id when `source === "plugin"`. */
  pluginId?: string
}

const registry = new Map<string, SlashCommandDefinition>()

export interface RegisterSlashCommandResult {
  /** True when the registration replaced an existing entry with the same id. */
  replaced: boolean
}

export function registerSlashCommand(def: SlashCommandDefinition): RegisterSlashCommandResult {
  if (!def.id || typeof def.id !== "string") {
    throw new Error("registerSlashCommand: id is required")
  }
  if (typeof def.handler !== "function") {
    throw new Error(`registerSlashCommand: handler for "${def.id}" must be a function`)
  }
  const replaced = registry.has(def.id)
  registry.set(def.id, def)
  return { replaced }
}

export function unregisterSlashCommand(id: string): boolean {
  return registry.delete(id)
}

/**
 * Bulk-unregister every command tagged with `pluginId`. Returns the number
 * of commands removed.
 */
export function unregisterCommandsByPlugin(pluginId: string): number {
  let removed = 0
  for (const [id, def] of registry) {
    if (def.pluginId === pluginId) {
      registry.delete(id)
      removed += 1
    }
  }
  return removed
}

export function getSlashCommand(id: string): SlashCommandDefinition | undefined {
  return registry.get(id)
}

export function listSlashCommands(): SlashCommandDefinition[] {
  return Array.from(registry.values())
}

export function listCommandsByPlugin(pluginId: string): SlashCommandDefinition[] {
  return listSlashCommands().filter((def) => def.pluginId === pluginId)
}

/**
 * Parse and dispatch a slash-command line. Format: `/<command> <rest>` where
 * `<command>` is the command id. Returns `null` when the input is not a
 * slash command or no handler is registered for it; throws when the handler
 * itself throws.
 */
export async function dispatchSlashCommand(
  line: string,
  ctx?: SlashCommandContext
): Promise<SlashCommandResult | null> {
  const trimmed = line.trim()
  if (!trimmed.startsWith("/")) return null
  const space = trimmed.indexOf(" ")
  const id = (space === -1 ? trimmed.slice(1) : trimmed.slice(1, space)).trim()
  const args = space === -1 ? "" : trimmed.slice(space + 1)
  const def = registry.get(id)
  if (!def) return null
  return def.handler(args, ctx)
}

/** Test-only escape hatch. */
export function __resetSlashCommandsForTesting(): void {
  registry.clear()
}
