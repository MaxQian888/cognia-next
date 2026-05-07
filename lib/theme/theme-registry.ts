// Theme registry (§E new module).
//
// Plugins declaring the `themes` capability contribute UI theme variants.
// cognia-next stores user themes as Dexie rows in `customThemes`, but there
// is no programmatic registration API for ephemeral / plugin-contributed
// themes today. This module is the runtime registry.
//
// Persistence model: plugin themes live ONLY in this in-memory registry —
// disabling the plugin removes them. If a user wants to keep a theme they
// can clone it into the persistent `customThemes` table through the
// settings UI; that flow is beyond this module's scope.
//
// Subscribe / snapshot semantics: the registry exposes `subscribeThemeRegistry`
// + a stable-reference `listPluginThemes()` snapshot so React's
// `useSyncExternalStore` can drive the appearance UI without re-render loops.
// The snapshot reference is invalidated only on mutation.

import type { ThemeColors } from "@/types/plugin/plugin-extended"

export interface PluginTheme {
  /** Stable id (typically `${pluginId}.${themeName}`). */
  id: string
  /** User-facing name. */
  name: string
  /** Optional description shown in the theme picker. */
  description?: string
  /**
   * Theme variables. Each key is a CSS variable name (e.g., `--background`)
   * and each value is the CSS value (e.g., `oklch(0.98 0 0)`). Cognia
   * groups light/dark via separate themes; we mirror that pattern.
   */
  variables: Record<string, string>
  /** Light or dark variant — drives the picker icon. */
  variant?: "light" | "dark"
  /** Origin tag — set by the plugin manager. */
  source?: "builtin" | "plugin"
  pluginId?: string
  /**
   * Optional structured palette parallel to `variables`. The themes-bridge
   * fills both so the appearance UI can synthesise swatches without
   * reverse-parsing CSS variables. When set, prefer this over `variables`
   * for swatch / preview rendering.
   */
  colors?: ThemeColors
  /** Mirrors `CustomTheme.isDark`. Useful for filter UI in the theme tab. */
  isDark?: boolean
  /** Human-readable plugin name for source badges in the UI. */
  pluginName?: string
}

const registry = new Map<string, PluginTheme>()
const listeners = new Set<() => void>()
let snapshot: PluginTheme[] | null = null

function notify(): void {
  // Invalidate the cached snapshot first so listeners that re-call
  // `listPluginThemes()` synchronously see the latest entries.
  snapshot = null
  for (const fn of listeners) {
    try {
      fn()
    } catch {
      // Listener errors are isolated — they should not break notification
      // for the rest of the subscriber set.
    }
  }
}

export function registerPluginTheme(theme: PluginTheme): { replaced: boolean } {
  if (!theme.id) throw new Error("registerPluginTheme: id is required")
  const replaced = registry.has(theme.id)
  registry.set(theme.id, theme)
  notify()
  return { replaced }
}

export function unregisterPluginTheme(id: string): boolean {
  const removed = registry.delete(id)
  if (removed) notify()
  return removed
}

export function unregisterThemesByPlugin(pluginId: string): number {
  let removed = 0
  for (const [id, theme] of registry) {
    if (theme.pluginId === pluginId) {
      registry.delete(id)
      removed += 1
    }
  }
  if (removed > 0) notify()
  return removed
}

export function getPluginTheme(id: string): PluginTheme | undefined {
  return registry.get(id)
}

/**
 * Returns a stable snapshot of registered plugin themes. The reference is
 * preserved between `notify()` calls so `useSyncExternalStore` won't loop.
 * Mutations invalidate the snapshot; the next call rebuilds it lazily.
 */
export function listPluginThemes(): PluginTheme[] {
  if (snapshot === null) {
    snapshot = Array.from(registry.values())
  }
  return snapshot
}

export function subscribeThemeRegistry(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Test-only escape hatch. */
export function __resetThemeRegistryForTesting(): void {
  registry.clear()
  notify()
}
