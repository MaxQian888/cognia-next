// In-process registry of plugin-contributed tray items. Mirrors the slash
// command registry pattern (`lib/slash-commands/registry.ts:64,84`) so the
// plugin manager can bulk-remove a plugin's items on disable through one
// well-known function.
//
// Plugin items are added here by `lib/plugin/api/tray-api.ts` after the
// Rust-side `plugin_tray_item_register` IPC has acknowledged. The renderer
// reads them via `listTrayItems()` when assembling the
// "All Commands ▶ Plugins" submenu.

import { loggers } from "@/lib/logging"

export interface PluginTrayItem {
  id: string
  pluginId: string
  label: string
  icon?: string
  /** when-expression evaluated by `lib/tray/when.ts` before flushing. */
  when?: string
  /** Free-form category — used by `lib/tray/all-commands.ts` for grouping. */
  category?: string
  /** Optional shortcut hint, cosmetic in the OS menu. */
  accelerator?: string
}

type Listener = (snapshot: PluginTrayItem[]) => void

const items = new Map<string, PluginTrayItem>()
const listeners = new Set<Listener>()

function emit(): void {
  if (listeners.size === 0) return
  const snapshot = Array.from(items.values())
  queueMicrotask(() => {
    for (const fn of listeners) {
      try {
        fn(snapshot)
      } catch (err) {
        loggers.tray.warn("tray registry listener threw", { error: String(err) })
      }
    }
  })
}

export function registerTrayItem(item: PluginTrayItem): void {
  if (!item.id) throw new Error("registerTrayItem: id is required")
  if (!item.pluginId) throw new Error("registerTrayItem: pluginId is required")
  items.set(item.id, item)
  emit()
}

export function unregisterTrayItem(id: string): boolean {
  const removed = items.delete(id)
  if (removed) emit()
  return removed
}

/**
 * Bulk-remove every item tagged with `pluginId`. Returns the count removed
 * — mirrors `unregisterCommandsByPlugin` so the plugin manager's
 * disable/unload flow stays uniform across registries.
 */
export function unregisterTrayItemsByPlugin(pluginId: string): number {
  let removed = 0
  for (const [id, item] of items) {
    if (item.pluginId === pluginId) {
      items.delete(id)
      removed++
    }
  }
  if (removed > 0) emit()
  return removed
}

export function listTrayItems(): PluginTrayItem[] {
  return Array.from(items.values())
}

export function listTrayItemsByPlugin(pluginId: string): PluginTrayItem[] {
  return listTrayItems().filter((item) => item.pluginId === pluginId)
}

export function getTrayItem(id: string): PluginTrayItem | undefined {
  return items.get(id)
}

export function subscribeTrayItems(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Test-only escape hatch. */
export function __resetTrayRegistryForTesting(): void {
  items.clear()
  listeners.clear()
}
