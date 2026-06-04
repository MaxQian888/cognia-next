/**
 * Renderer-side registry of plugin-contributed context-menu items — the
 * missing consumer half of `ctx.contextMenu.register(...)`.
 *
 * The Rust `plugin_context_menu_register` command only persists the
 * registration intent ("the renderer renders the actual menu" —
 * src-tauri/src/plugin_api/context_menu.rs). Until now nothing rendered
 * those items: registration was write-only. This registry mirrors the tray
 * registry pattern (`lib/tray/registry.ts`) so UI surfaces can read items
 * per zone via `usePluginContextMenuItems(zone)` and the plugin manager
 * can bulk-remove a plugin's items on disable.
 *
 * Zone model: `ContextMenuItem.when` is already typed as
 * `ContextMenuContext | ContextMenuContext[]` — "which zones does this
 * item target". `undefined` targets every zone.
 */

import { loggers } from "@/lib/logging"
import type { ContextMenuContext, ContextMenuItem } from "@/types/plugin"

export interface PluginContextMenuEntry {
  /** Namespaced id: `<pluginId>:<localId>` (matches the CustomEvent name). */
  id: string
  pluginId: string
  item: ContextMenuItem
}

const items = new Map<string, PluginContextMenuEntry>()

type Listener = () => void
const listeners = new Set<Listener>()

// `useSyncExternalStore`-stable snapshot.
let snapshot: readonly PluginContextMenuEntry[] | null = null

function emit(): void {
  snapshot = null
  if (listeners.size === 0) return
  queueMicrotask(() => {
    for (const fn of listeners) {
      try {
        fn()
      } catch (err) {
        loggers.plugin.warn("context-menu registry listener threw", { error: String(err) })
      }
    }
  })
}

export function registerContextMenuItem(entry: PluginContextMenuEntry): void {
  if (!entry.id) throw new Error("registerContextMenuItem: id is required")
  if (!entry.pluginId) throw new Error("registerContextMenuItem: pluginId is required")
  items.set(entry.id, entry)
  emit()
}

export function unregisterContextMenuItem(id: string): boolean {
  const removed = items.delete(id)
  if (removed) emit()
  return removed
}

/** Bulk-remove every item tagged with `pluginId` (plugin disable/unload). */
export function unregisterContextMenuItemsByPlugin(pluginId: string): number {
  let removed = 0
  for (const [id, entry] of items) {
    if (entry.pluginId === pluginId) {
      items.delete(id)
      removed++
    }
  }
  if (removed > 0) emit()
  return removed
}

function targetsZone(item: ContextMenuItem, zone: ContextMenuContext): boolean {
  if (!item.when) return true
  return Array.isArray(item.when) ? item.when.includes(zone) : item.when === zone
}

/** Items targeting `zone`, in registration order. */
export function listContextMenuItemsForZone(zone: ContextMenuContext): PluginContextMenuEntry[] {
  return [...items.values()].filter((e) => targetsZone(e.item, zone))
}

/** Stable-snapshot read for `useSyncExternalStore` (all zones). */
export function getContextMenuSnapshot(): readonly PluginContextMenuEntry[] {
  if (!snapshot) snapshot = [...items.values()]
  return snapshot
}

export function subscribeContextMenuItems(fn: Listener): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** Test-only escape hatch. */
export function __resetContextMenuRegistryForTesting(): void {
  items.clear()
  listeners.clear()
  snapshot = null
}
