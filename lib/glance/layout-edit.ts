/**
 * Edits to a glance layout (ADR-0225 §12), shared by the panel's in-place edit
 * mode and the settings editor so the two cannot disagree on what an edit
 * means.
 *
 * Every function is pure and returns a full, normalized entry list: visible
 * entries first in render order, hidden entries after them in their previous
 * relative order. A module the platform does not offer (`available`) is never
 * shown by an edit. Any edit makes the layout `custom` (§2); applying a preset
 * is the way back.
 */

import type {
  GlanceLayoutEntry,
  GlanceModuleId,
  GlanceModuleSize,
  GlancePanelSettings,
  GlancePresetId,
} from "@/types/glance/layout"

import { layoutFromPreset, normalizeEntries } from "./presets"
import { effectiveSize } from "./registry"

function visibleFirst(entries: readonly GlanceLayoutEntry[]): GlanceLayoutEntry[] {
  return [...entries.filter((e) => !e.hidden), ...entries.filter((e) => e.hidden)]
}

/** Put the visible entries in `orderedVisibleIds` order. Ids not visible are ignored. */
export function reorderVisible(
  entries: readonly GlanceLayoutEntry[],
  orderedVisibleIds: readonly GlanceModuleId[]
): GlanceLayoutEntry[] {
  const visible = entries.filter((e) => !e.hidden)
  const byId = new Map(visible.map((e) => [e.id, e]))
  const ordered: GlanceLayoutEntry[] = []
  for (const id of orderedVisibleIds) {
    const entry = byId.get(id)
    if (!entry) continue
    ordered.push(entry)
    byId.delete(id)
  }
  // Anything the caller left out keeps its place after the ones it named.
  for (const entry of visible) if (byId.has(entry.id)) ordered.push(entry)
  return [...ordered, ...entries.filter((e) => e.hidden)]
}

/** Move one visible entry by `delta` places (keyboard and button reordering). */
export function moveVisible(
  entries: readonly GlanceLayoutEntry[],
  id: GlanceModuleId,
  delta: number
): GlanceLayoutEntry[] {
  const ids = entries.filter((e) => !e.hidden).map((e) => e.id)
  const from = ids.indexOf(id)
  if (from < 0) return visibleFirst(entries)
  const to = Math.max(0, Math.min(ids.length - 1, from + delta))
  if (to === from) return visibleFirst(entries)
  ids.splice(to, 0, ...ids.splice(from, 1))
  return reorderVisible(entries, ids)
}

/** Resize one entry, degrading to a size the module supports. */
export function resizeEntry(
  entries: readonly GlanceLayoutEntry[],
  id: GlanceModuleId,
  size: GlanceModuleSize
): GlanceLayoutEntry[] {
  return visibleFirst(
    entries.map((e) => (e.id === id ? { ...e, size: effectiveSize(id, size) } : e))
  )
}

/** Hide one entry. It moves to the head of the hidden group, so "show" undoes it in place. */
export function hideEntry(
  entries: readonly GlanceLayoutEntry[],
  id: GlanceModuleId
): GlanceLayoutEntry[] {
  const target = entries.find((e) => e.id === id)
  if (!target || target.hidden) return visibleFirst(entries)
  const rest = entries.filter((e) => e.id !== id)
  return [
    ...rest.filter((e) => !e.hidden),
    { ...target, hidden: true },
    ...rest.filter((e) => e.hidden),
  ]
}

/** Show one hidden entry at the end of the stack, unless the platform lacks it. */
export function showEntry(
  entries: readonly GlanceLayoutEntry[],
  id: GlanceModuleId,
  available: readonly GlanceModuleId[]
): GlanceLayoutEntry[] {
  const target = entries.find((e) => e.id === id)
  if (!target || !target.hidden || !available.includes(id)) return visibleFirst(entries)
  const rest = entries.filter((e) => e.id !== id)
  return [
    ...rest.filter((e) => !e.hidden),
    { ...target, hidden: false },
    ...rest.filter((e) => e.hidden),
  ]
}

/** The layout after an edit: the new entries, and `custom`. */
export function withEditedEntries(
  settings: GlancePanelSettings,
  entries: readonly GlanceLayoutEntry[]
): GlancePanelSettings {
  return { ...settings, preset: "custom", entries: normalizeEntries(entries) }
}

/** The layout after applying a preset: its entries, and its id. Options are kept. */
export function withPreset(
  settings: GlancePanelSettings,
  preset: GlancePresetId
): GlancePanelSettings {
  return { ...settings, preset, entries: layoutFromPreset(preset) }
}
