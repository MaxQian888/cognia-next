/**
 * Quick-action overlay registry.
 *
 * A quick action IS a command with surface metadata: every registration is
 * mirrored into the unified command registry
 * (`lib/plugin/commands/registry.ts`) so dispatch — palette select, tray
 * click, shortcut accelerator — reuses `executeCommand` instead of growing
 * a fourth dispatch rail. The overlay registry holds the surface metadata
 * (`surfaces`, `when`, `icon`, …) the renderers read.
 *
 * Tray pickup is automatic: `lib/tray/all-commands.ts` folds every
 * command-registry entry into the "plugins" bucket via `getCommands(true)`,
 * which drops `_`-prefixed ids — so actions whose `surfaces` exclude
 * `"tray"` register their mirrored command under `_qa:<id>` and stay out
 * of the tray without any tray-side changes.
 */

import type { PluginQuickActionInput, PluginQuickActionSurface } from "@/types/plugin"
import { loggers } from "@cognia/logging"
import { registerCommand } from "@/lib/plugin/commands/registry"
import { reportRegistryConflict } from "@/lib/plugin/contracts/conflict-reporter"
import { createOverlayRegistry } from "./createOverlayRegistry"

export interface QuickActionEntry extends PluginQuickActionInput {
  /** Namespaced id: `<pluginId>:<localId>`. */
  fullId: string
  pluginId: string
  /** Id of the mirrored command-registry entry (dispatch handle). */
  commandId: string
  /** Resolved surfaces (defaults applied). */
  surfaces: PluginQuickActionSurface[]
}

const ALL_SURFACES: PluginQuickActionSurface[] = ["palette", "composer", "tray"]

const registry = createOverlayRegistry<QuickActionEntry>({
  name: "quick-action",
  conflictPolicy: "first-wins-cross-plugin",
  onConflict: (info) => {
    reportRegistryConflict({
      pluginId: info.incomingPluginId ?? "unknown",
      attemptedId: info.key,
      registry: "quick-action",
      winnerPluginId: info.existingPluginId,
    })
  },
})

/** Disposers for the mirrored command-registry entries, keyed by fullId. */
const commandDisposers = new Map<string, () => void>()

type Listener = () => void
const listeners = new Set<Listener>()

function emit(): void {
  // Invalidate unconditionally — snapshot staleness must not depend on
  // whether anyone is subscribed yet.
  invalidateSnapshot()
  if (listeners.size === 0) return
  queueMicrotask(() => {
    for (const fn of listeners) {
      try {
        fn()
      } catch (err) {
        loggers.plugin.warn("quick-action registry listener threw", { error: String(err) })
      }
    }
  })
}

// `useSyncExternalStore`-stable snapshot: identity changes only on mutation.
let snapshot: readonly QuickActionEntry[] | null = null

function invalidateSnapshot(): void {
  snapshot = null
}

/** Run a quick action: inline handler → command id → slash line. */
export async function runQuickAction(entry: QuickActionEntry): Promise<void> {
  if (entry.run) {
    await entry.run()
    return
  }
  if (entry.command) {
    const { executeCommand } = await import("@/lib/plugin/commands/registry")
    await executeCommand(entry.command)
    return
  }
  if (entry.slash) {
    const { dispatchSlashCommand } = await import("@/lib/slash-commands/registry")
    const line = entry.slash.startsWith("/") ? entry.slash : `/${entry.slash}`
    await dispatchSlashCommand(line)
    return
  }
  loggers.plugin.warn("quick action has no dispatch target", {
    pluginId: entry.pluginId,
    id: entry.fullId,
  })
}

/**
 * Register one quick action for `pluginId`. Mirrors a dispatch command into
 * the command registry. Returns a disposer that removes both.
 */
export function registerQuickAction(pluginId: string, action: PluginQuickActionInput): () => void {
  if (!action.run && !action.command && !action.slash) {
    // Still registered (the overlay contract is uniform: every manifest
    // entry round-trips through register/unregisterAllByPlugin) — but
    // dispatch will warn and no-op until the plugin declares a target.
    loggers.plugin.warn(
      "quick action has no dispatch target (run / command / slash) — it will no-op when invoked",
      { pluginId, id: action.id }
    )
  }

  const fullId = `${pluginId}:${action.id}`
  const surfaces = action.surfaces?.length ? [...action.surfaces] : [...ALL_SURFACES]
  // `_`-prefixed command ids are filtered out of `getCommands(true)`, which
  // is exactly the tray's pickup query — see module docs.
  const commandId = surfaces.includes("tray") ? `qa:${fullId}` : `_qa:${fullId}`

  const entry: QuickActionEntry = {
    ...action,
    fullId,
    pluginId,
    commandId,
    surfaces,
  }

  const previous = registry.register(fullId, entry, { pluginId })
  if (previous && previous.pluginId !== pluginId) {
    // first-wins-cross-plugin rejected the registration; don't mirror.
    return () => {}
  }

  // Re-registration by the same plugin (hot reload): drop the stale mirror.
  commandDisposers.get(fullId)?.()
  const disposeCommand = registerCommand({
    id: commandId,
    title: action.title,
    category: action.category ?? "plugins",
    pluginId,
    when: action.when,
    handler: () => runQuickAction(entry),
  })

  // Optional accelerator — bound through the plugin shortcut bridge onto
  // the live shortcut rail (the binding id IS the mirrored command id, so
  // an OS press dispatches the same handler as palette/tray/composer).
  let disposeAccelerator: (() => void) | null = null
  let acceleratorDisposed = false
  if (action.accelerator) {
    import("@/lib/plugin/shortcuts/plugin-shortcut-bridge")
      .then(({ bindPluginShortcut }) =>
        bindPluginShortcut({
          pluginId,
          chord: action.accelerator!,
          existingCommandId: commandId,
          options: { when: action.when },
        })
      )
      .then((d) => {
        if (acceleratorDisposed) d()
        else disposeAccelerator = d
      })
      .catch((err) => {
        loggers.plugin.warn("quick action accelerator bind failed", {
          pluginId,
          id: fullId,
          error: String(err),
        })
      })
  }

  const disposeAll = () => {
    disposeCommand()
    acceleratorDisposed = true
    disposeAccelerator?.()
    disposeAccelerator = null
  }
  commandDisposers.set(fullId, disposeAll)
  emit()

  return () => {
    registry.unregisterById(fullId)
    commandDisposers.get(fullId)?.()
    commandDisposers.delete(fullId)
    emit()
  }
}

/** Bulk cleanup for plugin disable/uninstall. Returns the count removed. */
export function unregisterQuickActionsByPlugin(pluginId: string): number {
  const owned = registry.entries().filter((e) => e.pluginId === pluginId)
  const removed = registry.unregisterByPlugin(pluginId)
  for (const e of owned) {
    commandDisposers.get(e.entry.fullId)?.()
    commandDisposers.delete(e.entry.fullId)
  }
  if (removed > 0) emit()
  return removed
}

export function getQuickAction(fullId: string): QuickActionEntry | undefined {
  return registry.get(fullId)
}

/** List actions, optionally filtered to one surface. Snapshot is
 * `useSyncExternalStore`-stable (identity changes only on mutation). */
export function listQuickActions(surface?: PluginQuickActionSurface): readonly QuickActionEntry[] {
  if (!snapshot) snapshot = registry.entries().map((e) => e.entry)
  if (!surface) return snapshot
  return snapshot.filter((e) => e.surfaces.includes(surface))
}

/** Stable-snapshot read for `useSyncExternalStore`. */
export function getQuickActionSnapshot(): readonly QuickActionEntry[] {
  if (!snapshot) snapshot = registry.entries().map((e) => e.entry)
  return snapshot
}

export function subscribeQuickActions(fn: Listener): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** Test-only escape hatch. */
export function __resetQuickActionsForTesting(): void {
  for (const dispose of commandDisposers.values()) dispose()
  commandDisposers.clear()
  registry.__resetForTesting()
  listeners.clear()
  invalidateSnapshot()
}
