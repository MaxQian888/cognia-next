/**
 * Unified command registry for cognia.
 *
 * VS Code extensions reuse-layer (see `~/.claude/plans/vscode-snug-squid.md`)
 * needs a single command bus so `vscode.commands.registerCommand` /
 * `vscode.commands.executeCommand` / `vscode.commands.getCommands` can be
 * implemented in the sidecar's `vscode-shim/commands.ts` by RPC-ing into
 * this registry from the renderer.
 *
 * Mirrors `lib/workflow/nodes/registry.ts`:
 *   • synchronous mutation, microtask-deferred listener dispatch (so React
 *     effects subscribing after registration still observe initial state),
 *   • idempotent unregister,
 *   • per-plugin tracking via `pluginId` so a plugin's commands can be
 *     bulk-unregistered when it disables.
 *
 * Cognia-native commands (slash commands, settings, plugins) register through
 * the same surface — the registry doesn't distinguish between cognia-side and
 * VS Code-extension-side callers.
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

const registry = new Map<string, CommandRegistration>()
const listeners = new Set<CommandRegistryListener>()

function emit(event: CommandRegistryEvent): void {
  queueMicrotask(() => {
    for (const fn of listeners) {
      try {
        fn(event)
      } catch (err) {
        // Listeners must not throw across the registry boundary.

        console.warn("Command registry listener threw:", err)
      }
    }
  })
}

/**
 * Register a command. If a command with the same id already exists, the
 * new registration wins and a `replace` warning is logged — VS Code allows
 * overrides, and the cognia agent system relies on later registrations
 * taking precedence (e.g. a plugin overriding a built-in slash command).
 */
export function registerCommand(reg: CommandRegistration): () => void {
  if (registry.has(reg.id)) {
    const existing = registry.get(reg.id)
    console.warn(
      `Command "${reg.id}" already registered by plugin "${existing?.pluginId ?? "cognia"}" — overridden by "${reg.pluginId ?? "cognia"}"`
    )
  }
  registry.set(reg.id, reg)
  emit({ type: "register", id: reg.id, pluginId: reg.pluginId })
  return () => unregisterCommand(reg.id)
}

/**
 * Idempotent — silently no-ops if the command isn't registered.
 */
export function unregisterCommand(id: string): void {
  const entry = registry.get(id)
  if (!entry) return
  registry.delete(id)
  emit({ type: "unregister", id, pluginId: entry.pluginId })
}

/**
 * Bulk-remove every command registered by a plugin. Called when the plugin
 * deactivates / uninstalls. Returns the count removed for logging.
 */
export function unregisterCommandsByPlugin(pluginId: string): number {
  let removed = 0
  for (const [id, entry] of registry) {
    if (entry.pluginId === pluginId) {
      registry.delete(id)
      emit({ type: "unregister", id, pluginId })
      removed += 1
    }
  }
  return removed
}

export function getCommand(id: string): CommandRegistration | undefined {
  return registry.get(id)
}

/**
 * VS Code's `getCommands(filterInternal)` returns either every command id
 * or a subset filtered by the `filterInternal` flag (commands whose id
 * starts with `_` are considered internal). We model the same behaviour.
 */
export function getCommands(filterInternal = false): string[] {
  const out: string[] = []
  for (const id of registry.keys()) {
    if (filterInternal && id.startsWith("_")) continue
    out.push(id)
  }
  return out.sort()
}

export function listCommandsByPlugin(pluginId: string): CommandRegistration[] {
  const out: CommandRegistration[] = []
  for (const entry of registry.values()) {
    if (entry.pluginId === pluginId) out.push(entry)
  }
  return out
}

/**
 * Execute a registered command. Returns the handler's return value (or
 * resolves the promise). Throws `CommandNotFoundError` when the id is
 * unknown — VS Code throws the same.
 */
export async function executeCommand<T = unknown>(id: string, ...args: unknown[]): Promise<T> {
  const entry = registry.get(id)
  if (!entry) {
    throw new CommandNotFoundError(id)
  }
  const result = await entry.handler(...args)
  return result as T
}

export function subscribeCommandRegistry(listener: CommandRegistryListener): () => void {
  listeners.add(listener)
  // Emit a "register" event for each existing registration in the next
  // microtask so subscribers can rehydrate without polling.
  queueMicrotask(() => {
    for (const entry of registry.values()) {
      try {
        listener({ type: "register", id: entry.id, pluginId: entry.pluginId })
      } catch (err) {
        console.warn("Command registry listener threw on rehydrate:", err)
      }
    }
  })
  return () => listeners.delete(listener)
}

/**
 * Test-only: drop everything. Production code should never call this.
 */
export function __resetCommandRegistryForTesting(): void {
  registry.clear()
  listeners.clear()
}

export class CommandNotFoundError extends Error {
  constructor(public readonly id: string) {
    super(`Command not found: ${id}`)
    this.name = "CommandNotFoundError"
  }
}
