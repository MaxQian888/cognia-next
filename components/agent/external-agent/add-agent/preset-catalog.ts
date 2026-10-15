/**
 * The shared preset catalogue, grouped for phone and desktop pickers.
 *
 * Presets the Host reports as installed come first: they are the ones that
 * will work the moment they are added, and on a phone the first screenful is
 * most of what anyone reads. Everything else follows in catalogue order. A
 * search narrows both groups the same way rather than flattening them, so the
 * "installed" signal survives a query.
 */

import {
  getAvailablePresets,
  getPresetConfig,
  getRunnablePresets,
} from "@/lib/ai/agent/external/config/presets"
import type { ExternalAgentPresetConfig } from "@/lib/ai/agent/external/config/presets"
import type { InstalledRuntime } from "@/lib/ai/agent/external/config/installed-runtimes"

export interface PresetEntry {
  id: string
  preset: ExternalAgentPresetConfig
  /** Display name, already translated where the catalogue carries one. */
  name: string
  /** One-paragraph description, already translated where available. */
  description: string
}

export interface GroupedPresets {
  installed: PresetEntry[]
  others: PresetEntry[]
  experimental: PresetEntry[]
}

/** Every runnable preset as a picker entry. `describe` supplies the translated copy. */
export function runnablePresetEntries(
  describe: (id: string, preset: ExternalAgentPresetConfig) => { name: string; description: string }
): PresetEntry[] {
  return presetEntries(getRunnablePresets(), describe)
}

/** Desktop includes documented-only presets so their limitations remain discoverable. */
export function availablePresetEntries(
  describe: (id: string, preset: ExternalAgentPresetConfig) => { name: string; description: string }
): PresetEntry[] {
  return presetEntries(getAvailablePresets(), describe)
}

function presetEntries(
  ids: readonly string[],
  describe: (id: string, preset: ExternalAgentPresetConfig) => { name: string; description: string }
): PresetEntry[] {
  const entries: PresetEntry[] = []
  for (const id of ids) {
    const preset = getPresetConfig(id)
    if (!preset) continue
    entries.push({ id, preset, ...describe(id, preset) })
  }
  return entries
}

function matches(entry: PresetEntry, query: string): boolean {
  if (!query) return true
  const haystack = [entry.id, entry.name, entry.description, ...(entry.preset.tags ?? [])]
    .join(" ")
    .toLowerCase()
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => haystack.includes(term))
}

export function groupPresetEntries(
  entries: readonly PresetEntry[],
  forPreset: (presetId: string) => InstalledRuntime | undefined,
  query: string
): GroupedPresets {
  const installed: PresetEntry[] = []
  const others: PresetEntry[] = []
  const experimental: PresetEntry[] = []
  const trimmed = query.trim()
  for (const entry of entries) {
    if (!matches(entry, trimmed)) continue
    if (entry.preset.supportTier === "documented-only") experimental.push(entry)
    else if (forPreset(entry.id)?.resolution === "installed") installed.push(entry)
    else others.push(entry)
  }
  return { installed, others, experimental }
}
