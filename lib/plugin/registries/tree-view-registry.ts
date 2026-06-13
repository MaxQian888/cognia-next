/**
 * View registry (B2) — holds resolved plugin views (tree providers + custom
 * React panels), keyed by `<pluginId>:<viewId>` and grouped by container.
 *
 * The view-bridge (`lib/plugin/bridge/view-bridge.ts`) dynamic-imports each
 * `manifest.views[]` entry on enable and calls `registerView`; the manager's
 * module-bridge unregister calls `unregisterViewsByPlugin` on disable. The B1
 * container panel (`components/shell/plugin-view-container-panel.tsx`) reads
 * `listViewsForContainer(containerId)` and renders each via the tree/custom
 * view host.
 *
 * Mirrors the view-container registry's overlay + subscribe shape.
 */

import type { ResolvedPluginView } from "@/types/plugin/plugin-view"
import { loggers } from "@/lib/logging"

const views = new Map<string, ResolvedPluginView>()

type Listener = () => void
const listeners = new Set<Listener>()
let snapshot: readonly ResolvedPluginView[] | null = null

function emit(): void {
  snapshot = null
  if (listeners.size === 0) return
  queueMicrotask(() => {
    for (const fn of listeners) {
      try {
        fn()
      } catch (err) {
        loggers.plugin.warn("view registry listener threw", { error: String(err) })
      }
    }
  })
}

/** Full key for a resolved view. */
function keyOf(view: ResolvedPluginView): string {
  return `${view.pluginId}:${view.viewId}`
}

/** Register one resolved view. Re-registering the same key replaces it. */
export function registerView(view: ResolvedPluginView): () => void {
  const key = keyOf(view)
  views.set(key, view)
  emit()
  return () => {
    if (views.delete(key)) emit()
  }
}

/** Bulk cleanup for plugin disable/uninstall. Returns the count removed. */
export function unregisterViewsByPlugin(pluginId: string): number {
  let removed = 0
  for (const [key, view] of views) {
    if (view.pluginId === pluginId) {
      views.delete(key)
      removed++
    }
  }
  if (removed > 0) emit()
  return removed
}

/** Stable-snapshot read for `useSyncExternalStore` (registration order). */
export function getViewSnapshot(): readonly ResolvedPluginView[] {
  if (!snapshot) snapshot = [...views.values()]
  return snapshot
}

/** Views registered for a specific container (`<pluginId>:<containerLocalId>`). */
export function listViewsForContainer(containerId: string): ResolvedPluginView[] {
  return getViewSnapshot().filter((v) => v.containerId === containerId)
}

export function subscribeViews(fn: Listener): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** Test-only escape hatch. */
export function __resetViewsForTesting(): void {
  views.clear()
  listeners.clear()
  snapshot = null
}
