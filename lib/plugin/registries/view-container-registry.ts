/**
 * View-container overlay registry (B1).
 *
 * Plugins shipping the `view-container` capability contribute rail-mounted
 * containers via `manifest.viewsContainers`. The `OVERLAY_REGISTRY_CAPABILITIES`
 * dispatch loop in `lib/plugin/core/manager.ts` calls `registerViewContainer`
 * per entry on enable and `unregisterViewContainersByPlugin(pluginId)` on
 * disable. The left rail (`components/shell/guild-rail.tsx`) reads the live
 * snapshot to render a button per container; selecting one swaps the middle
 * column to `components/shell/plugin-view-container-panel.tsx`.
 *
 * Mirrors the quick-action registry's overlay + subscribe shape so the rail
 * can `useSyncExternalStore` against an identity-stable snapshot.
 */

import type { PluginViewContainerDef } from "@/types/plugin/plugin-view-container"
import { loggers } from "@cognia/logging"
import { createOverlayRegistry } from "./createOverlayRegistry"

export interface ViewContainerEntry {
  /** Namespaced id: `<pluginId>:<localId>`. */
  fullId: string
  pluginId: string
  def: PluginViewContainerDef
}

const registry = createOverlayRegistry<ViewContainerEntry>({ name: "view-container" })

type Listener = () => void
const listeners = new Set<Listener>()
let snapshot: readonly ViewContainerEntry[] | null = null

function emit(): void {
  snapshot = null
  if (listeners.size === 0) return
  queueMicrotask(() => {
    for (const fn of listeners) {
      try {
        fn()
      } catch (err) {
        loggers.plugin.warn("view-container registry listener threw", { error: String(err) })
      }
    }
  })
}

/**
 * Register one view container for `pluginId`. The overlay dispatch loop calls
 * this with `(def, { pluginId })`. Re-registering the same id replaces the
 * previous entry (hot reload).
 */
export function registerViewContainer(
  def: PluginViewContainerDef,
  ctx: { pluginId: string }
): () => void {
  const fullId = `${ctx.pluginId}:${def.id}`
  const entry: ViewContainerEntry = { fullId, pluginId: ctx.pluginId, def }
  registry.register(fullId, entry, { pluginId: ctx.pluginId })
  emit()
  return () => {
    if (registry.unregisterById(fullId)) emit()
  }
}

/** Bulk cleanup for plugin disable/uninstall. Returns the count removed. */
export function unregisterViewContainersByPlugin(pluginId: string): number {
  const removed = registry.unregisterByPlugin(pluginId)
  if (removed > 0) emit()
  return removed
}

export function getViewContainer(fullId: string): ViewContainerEntry | undefined {
  return registry.get(fullId)
}

/** Stable-snapshot read for `useSyncExternalStore` (registration order). */
export function getViewContainerSnapshot(): readonly ViewContainerEntry[] {
  if (!snapshot) snapshot = registry.entries().map((e) => e.entry)
  return snapshot
}

export function subscribeViewContainers(fn: Listener): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** Test-only escape hatch. */
export function __resetViewContainersForTesting(): void {
  registry.__resetForTesting()
  listeners.clear()
  snapshot = null
}
