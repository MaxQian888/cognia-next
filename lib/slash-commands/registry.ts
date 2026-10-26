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

import { reportRegistryConflict } from "@/lib/plugin/contracts/conflict-reporter"
import type {
  RegisterSlashCommandResult,
  SlashCommandContext,
  SlashCommandDefinition,
  SlashCommandResult,
} from "@cognia/plugin-contract/lib/slash-commands/registry"
export type {
  RegisterSlashCommandResult,
  SlashCommandContext,
  SlashCommandDefinition,
  SlashCommandHandler,
  SlashCommandResult,
} from "@cognia/plugin-contract/lib/slash-commands/registry"

const registry = new Map<string, SlashCommandDefinition>()

// --- Change notification ------------------------------------------------
// The registry is a bare Map with no built-in reactivity. The chat composer's
// `/` picker subscribes (via `useSyncExternalStore` in
// `hooks/chat/use-plugin-slash-commands.ts`) so newly-registered plugin
// commands appear without a reload. We expose a monotonic version counter as
// the snapshot — cheap to compare, and consumers re-derive their projection
// when it changes.
let version = 0
const listeners = new Set<() => void>()

function notifySlashCommandsChanged(): void {
  version += 1
  for (const cb of listeners) cb()
}

/** Subscribe to registry mutations; returns an unsubscribe fn. */
export function subscribeSlashCommands(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** Monotonic version, bumped on every register/unregister/seed. */
export function getSlashCommandsVersion(): number {
  return version
}

export function registerSlashCommand(def: SlashCommandDefinition): RegisterSlashCommandResult {
  if (!def.id || typeof def.id !== "string") {
    throw new Error("registerSlashCommand: id is required")
  }
  if (typeof def.handler !== "function") {
    throw new Error(`registerSlashCommand: handler for "${def.id}" must be a function`)
  }
  const existing = registry.get(def.id)

  // First-wins across DIFFERENT plugins: when a plugin tries to register a
  // command id another plugin already owns, the incumbent wins and the later
  // registration is rejected + reported. Builtin (re)seeding and a plugin
  // refreshing its OWN id keep last-wins so hot-reload / re-seed still work.
  if (
    existing &&
    def.source === "plugin" &&
    existing.source === "plugin" &&
    existing.pluginId !== def.pluginId
  ) {
    reportRegistryConflict({
      pluginId: def.pluginId ?? "unknown",
      attemptedId: def.id,
      registry: "slash command",
      winnerPluginId: existing.pluginId,
    })
    return { replaced: false }
  }

  const replaced = existing !== undefined
  registry.set(def.id, def)
  notifySlashCommandsChanged()
  return { replaced }
}

export function unregisterSlashCommand(id: string): boolean {
  const removed = registry.delete(id)
  if (removed) notifySlashCommandsChanged()
  return removed
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
  if (removed > 0) notifySlashCommandsChanged()
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
  let def = registry.get(id)
  if (!def) {
    // Lazy activation: a plugin gated on `onCommand:<id>` is not enabled until
    // its command is first invoked. Fire the activation event, then re-resolve.
    // Dynamic import avoids a static cycle (manager → this registry); the
    // try/catch tolerates an uninitialized manager (SSR / tests / web profile).
    try {
      const { ensureBootCapability, getBootProfile } = await import("@/lib/boot/capabilities")
      if (getBootProfile() === "main") await ensureBootCapability("plugin-runtime")
      const { getPluginManager } = await import("@/lib/plugin/core/manager")
      await getPluginManager().handleActivationEvent(`onCommand:${id}`)
      def = registry.get(id)
    } catch {
      // Plugin manager not available — fall through to "not registered".
    }
    if (!def) return null
  }
  return def.handler(args, ctx)
}

/** Test-only escape hatch. */
export function __resetSlashCommandsForTesting(): void {
  registry.clear()
  notifySlashCommandsChanged()
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
