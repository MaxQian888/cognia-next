// Unified slash-command registry (Phase 3 of the ClaudeCode 完整化 plan).
//
// This is the SINGLE source of truth for any third-party / plugin / settings-
// surfaced slash command. It replaces the older `lib/chat/slash-command-
// registry.ts` (which now re-exports this module for backwards compatibility).
//
// Two consumers:
//   1. The plugin manager (`lib/plugin/core/manager.ts`) — registers plugin-
//      contributed commands and bulk-removes them when a plugin is disabled.
//   2. The Slash Commands settings section (Phase 7) — enumerates everything
//      in the registry to render a unified browser.
//
// The chat composer's actual dispatch path (`BUILTIN_SLASH_COMMANDS` action
// handlers, templates, custom .md commands) lives in `./builtin.ts` and
// `./custom.ts`. Those carry context-rich `SlashContext` (`activeSessionId`,
// `pushSystemMessage`, `openSettings`, ...) that the registry's lightweight
// `SlashCommandContext` cannot supply. To keep the surfaces aligned, the
// builtin module mirrors itself into THIS registry as descriptor-only entries
// (`source: "builtin"`) with a stub handler that nudges the caller back to
// the composer. See `seedBuiltinSlashCommands()` below.

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
  /**
   * Grouping key consumed by surfaces that list commands by section — most
   * notably the tray's "All Commands ▶" submenu. Free-form; the tray uses
   * the canonical buckets `chat | diagnostics | system | goal | template |
   * help | plugins`. Defaults to `"chat"` when absent.
   */
  category?: string
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

/**
 * Idempotently mirror the chat composer's BUILTIN_SLASH_COMMANDS into the
 * registry as descriptor-only entries. The actual handlers live in the
 * composer's dispatcher (which has the full `SlashContext`); the stubs here
 * exist so settings UIs can list them via `listSlashCommands()` without
 * importing the composer. Calling the stub directly returns a hint message
 * pointing the caller at the composer.
 *
 * `BUILTIN_SLASH_COMMANDS` is passed in to avoid a circular import with
 * `./builtin.ts` (which depends on this module's types via re-export).
 */
export function seedBuiltinSlashCommands(
  builtins: ReadonlyArray<{
    name: string
    description: string
    argumentHint?: string
    disabled?: boolean
    category?: string
  }>
): void {
  for (const cmd of builtins) {
    if (cmd.disabled) continue
    const def: SlashCommandDefinition = {
      id: cmd.name,
      name: cmd.name,
      description: cmd.description,
      shortcut: cmd.argumentHint ?? null,
      source: "builtin",
      category: cmd.category ?? "chat",
      handler: () => ({
        message: `'/${cmd.name}' is a built-in chat command — run it from the chat composer to access its full context.`,
      }),
    }
    registry.set(def.id, def)
  }
}
