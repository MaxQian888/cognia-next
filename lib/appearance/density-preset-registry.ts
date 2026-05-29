// Plugin density-preset registry — surfaces the named density presets a
// plugin contributes via `manifest.densityPresets[]`. A preset is a bundle of
// `--density-*` CSS custom-property overrides keyed by a bare `name`, which a
// `PluginThemePackContribution.applies.density` reference (or a direct
// `applyDensityPresetVars(name)` call) resolves at apply time.
//
// Modeled on `lib/appearance/font-registry.ts`: in-memory only, keyed by
// `${pluginId}:${name}`, with a subscribe/snapshot pair so pickers stay in
// sync without a Zustand entry. Presets do not survive plugin unload.

import type { PluginDensityPresetContribution } from "@/types/plugin/plugin"

export interface RegisteredDensityPreset {
  pluginId: string
  name: string
  vars: PluginDensityPresetContribution["vars"]
}

/** Keyed by `${pluginId}:${name}` for fast dedupe + per-plugin cleanup. */
const presets = new Map<string, RegisteredDensityPreset>()
const listeners = new Set<() => void>()
let snapshot: RegisteredDensityPreset[] | null = null

function emit(): void {
  snapshot = null
  for (const fn of listeners) {
    try {
      fn()
    } catch (err) {
      console.warn("Density preset registry listener threw:", err)
    }
  }
}

function key(pluginId: string, name: string): string {
  return `${pluginId}:${name}`
}

/** Register a single plugin-contributed density preset. Idempotent re-register replaces. */
export function registerDensityPreset(
  pluginId: string,
  preset: PluginDensityPresetContribution
): void {
  const name = preset.name?.trim()
  if (!name) return
  presets.set(key(pluginId, name), { pluginId, name, vars: preset.vars ?? {} })
  emit()
}

/** Register every preset a plugin contributes. Clears the plugin's prior set first. */
export function registerDensityPresetsForPlugin(
  pluginId: string,
  contributions: ReadonlyArray<PluginDensityPresetContribution>
): number {
  // Clear prior so re-enable doesn't leave stale presets.
  for (const k of [...presets.keys()]) {
    if (presets.get(k)?.pluginId === pluginId) presets.delete(k)
  }
  let registered = 0
  for (const preset of contributions) {
    const name = preset.name?.trim()
    if (!name) continue
    presets.set(key(pluginId, name), { pluginId, name, vars: preset.vars ?? {} })
    registered += 1
  }
  emit()
  return registered
}

/** Remove every density preset owned by `pluginId`. Returns the count removed. */
export function unregisterDensityPresetsByPlugin(pluginId: string): number {
  let removed = 0
  for (const [k, value] of presets) {
    if (value.pluginId === pluginId) {
      presets.delete(k)
      removed += 1
    }
  }
  if (removed > 0) emit()
  return removed
}

/** Look up a preset by its bare name. First registered match wins. */
export function getDensityPreset(name: string): RegisteredDensityPreset | undefined {
  for (const value of presets.values()) {
    if (value.name === name) return value
  }
  return undefined
}

/** Snapshot of every registered preset. Stable identity until the next mutation. */
export function listDensityPresets(): RegisteredDensityPreset[] {
  if (!snapshot) snapshot = [...presets.values()]
  return snapshot
}

export function subscribeDensityPresets(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Exposed for tests. */
export function __resetDensityPresetRegistryForTesting(): void {
  presets.clear()
  listeners.clear()
  snapshot = null
}
