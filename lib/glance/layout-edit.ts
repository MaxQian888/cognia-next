/**
 * Edits to a glance layout (ADR-0225 §12), shared by the panel's in-place edit
 * mode and the settings editor so the two cannot disagree on what an edit
 * means.
 *
 * Every function is pure and returns a full, normalized entry list: visible
 * entries first in render order, hidden entries after them in their previous
 * relative order. A module the platform does not offer (`available`) is never
 * shown by an edit. Any edit makes the layout `custom` (§2); applying a preset
 * is the way back. The entry functions are generic, so a phone's entries keep
 * their `home` pin through every edit.
 */

import type {
  GlanceLayoutEntry,
  GlanceMobileEntry,
  GlanceMobileSettings,
  GlanceModuleId,
  GlanceModuleSize,
  GlancePanelSettings,
  GlancePresetId,
} from "@/types/glance/layout"

import { mobileLayoutFromPreset, normalizeMobileEntries, normalizeShortcuts } from "./mobile-layout"
import { layoutFromPreset, normalizeEntries } from "./presets"
import { effectiveSize } from "./registry"

function visibleFirst<E extends GlanceLayoutEntry>(entries: readonly E[]): E[] {
  return [...entries.filter((e) => !e.hidden), ...entries.filter((e) => e.hidden)]
}

/** Put the visible entries in `orderedVisibleIds` order. Ids not visible are ignored. */
export function reorderVisible<E extends GlanceLayoutEntry>(
  entries: readonly E[],
  orderedVisibleIds: readonly GlanceModuleId[]
): E[] {
  const visible = entries.filter((e) => !e.hidden)
  const byId = new Map(visible.map((e) => [e.id, e]))
  const ordered: E[] = []
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
export function moveVisible<E extends GlanceLayoutEntry>(
  entries: readonly E[],
  id: GlanceModuleId,
  delta: number
): E[] {
  const ids = entries.filter((e) => !e.hidden).map((e) => e.id)
  const from = ids.indexOf(id)
  if (from < 0) return visibleFirst(entries)
  const to = Math.max(0, Math.min(ids.length - 1, from + delta))
  if (to === from) return visibleFirst(entries)
  ids.splice(to, 0, ...ids.splice(from, 1))
  return reorderVisible(entries, ids)
}

/** Resize one entry, degrading to a size the module supports. */
export function resizeEntry<E extends GlanceLayoutEntry>(
  entries: readonly E[],
  id: GlanceModuleId,
  size: GlanceModuleSize
): E[] {
  return visibleFirst(
    entries.map((e) => (e.id === id ? { ...e, size: effectiveSize(id, size) } : e))
  )
}

/** Hide one entry. It moves to the head of the hidden group, so "show" undoes it in place. */
export function hideEntry<E extends GlanceLayoutEntry>(
  entries: readonly E[],
  id: GlanceModuleId
): E[] {
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
export function showEntry<E extends GlanceLayoutEntry>(
  entries: readonly E[],
  id: GlanceModuleId,
  available: readonly GlanceModuleId[]
): E[] {
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

/**
 * Pin one entry to the phone's home screen, or unpin it. Pinning a hidden
 * entry also shows it, since the home renders only visible entries and a pin
 * the user cannot see would be a switch that does nothing.
 */
export function pinEntryHome(
  entries: readonly GlanceMobileEntry[],
  id: GlanceModuleId,
  home: boolean,
  available: readonly GlanceModuleId[]
): GlanceMobileEntry[] {
  const target = entries.find((e) => e.id === id)
  if (!target) return visibleFirst(entries)
  if (home && !available.includes(id)) return visibleFirst(entries)
  const shown = home && target.hidden ? showEntry(entries, id, available) : visibleFirst(entries)
  return shown.map((e) => (e.id === id ? { ...e, home } : e))
}

/** The phone's layout after an edit: the new entries, and `custom`. */
export function withEditedMobileEntries(
  settings: GlanceMobileSettings,
  entries: readonly GlanceMobileEntry[]
): GlanceMobileSettings {
  return { ...settings, preset: "custom", entries: normalizeMobileEntries(entries) }
}

/** The phone's layout after applying a preset. Shortcuts, scope and options are kept. */
export function withMobilePreset(
  settings: GlanceMobileSettings,
  preset: GlancePresetId
): GlanceMobileSettings {
  return { ...settings, preset, entries: mobileLayoutFromPreset(preset) }
}

/**
 * The phone's layout with a new shortcut list. The shortcuts are the quick
 * module's content, not the layout, so the preset is left alone.
 */
export function withShortcuts(
  settings: GlanceMobileSettings,
  shortcuts: readonly string[]
): GlanceMobileSettings {
  return { ...settings, shortcuts: normalizeShortcuts(shortcuts) }
}
