// Theme-pack registry (v47 — ADR-0029).
//
// A theme pack is a single applyable bundle declared by a plugin under
// `manifest.themePacks`. Each pack references *other* contributions from
// the same plugin (theme id, font family, wallpaper id) — the registry
// here just stores the metadata + applies map; resolution into actual
// settings writes happens in `components/settings/appearance/components/theme-pack-applier.tsx`
// (P6).
//
// Mirrors `theme-registry.ts`'s shape so React consumers can drive the UI
// via `useSyncExternalStore` without bespoke wiring.

import type { PluginThemePackContribution } from "@/types/plugin/plugin"

export interface RegisteredThemePack extends PluginThemePackContribution {
  /** Owning plugin id; the registry namespaces packs by it. */
  pluginId: string
  /** Display label for "where did this pack come from?". */
  pluginName?: string
}

const registry = new Map<string, RegisteredThemePack>()
const listeners = new Set<() => void>()
let snapshot: RegisteredThemePack[] | null = null

function key(pluginId: string, packId: string): string {
  return `${pluginId}.${packId}`
}

function notify(): void {
  snapshot = null
  for (const fn of listeners) {
    try {
      fn()
    } catch (err) {
      console.warn("Theme-pack listener threw:", err)
    }
  }
}

export function registerThemePack(input: {
  pluginId: string
  pluginName?: string
  pack: PluginThemePackContribution
}): { replaced: boolean } {
  if (!input.pack.id) throw new Error("registerThemePack: id is required")
  const id = key(input.pluginId, input.pack.id)
  const replaced = registry.has(id)
  registry.set(id, {
    ...input.pack,
    pluginId: input.pluginId,
    pluginName: input.pluginName,
  })
  notify()
  return { replaced }
}

export function unregisterThemePack(pluginId: string, packId: string): boolean {
  const removed = registry.delete(key(pluginId, packId))
  if (removed) notify()
  return removed
}

export function unregisterThemePacksByPlugin(pluginId: string): number {
  let removed = 0
  for (const [k, pack] of registry) {
    if (pack.pluginId === pluginId) {
      registry.delete(k)
      removed += 1
    }
  }
  if (removed > 0) notify()
  return removed
}

export function listThemePacks(): RegisteredThemePack[] {
  if (!snapshot) snapshot = [...registry.values()]
  return snapshot
}

export function getThemePack(pluginId: string, packId: string): RegisteredThemePack | undefined {
  return registry.get(key(pluginId, packId))
}

export function subscribeThemePackRegistry(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Test-only: drop everything. */
export function __resetThemePackRegistryForTesting(): void {
  registry.clear()
  listeners.clear()
  snapshot = null
}
