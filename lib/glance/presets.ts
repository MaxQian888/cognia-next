/**
 * Glance presets and settings normalization (ADR-0225 §2, §4, §10).
 *
 * A preset is a starting point, not a mode: editing any entry turns the layout
 * into `custom`, and "reset" re-applies a preset. Normalization is what lets a
 * stored layout survive a catalogue change in either direction. Unknown ids
 * are dropped, ids a newer build added are appended hidden (opt-in, never
 * auto-shown), duplicates keep their first position, and an unsupported size
 * degrades to the nearest supported one.
 */

import {
  DEFAULT_GLANCE_MODULE_OPTIONS,
  GLANCE_ACTIVITY_RANGES,
  GLANCE_MAX_HEIGHT_DEFAULT,
  GLANCE_MAX_HEIGHT_MAX,
  GLANCE_MAX_HEIGHT_MIN,
  GLANCE_MODULE_IDS,
  GLANCE_MODULE_SIZES,
  GLANCE_PRESET_IDS,
  GLANCE_WIDTH_STEPS,
  type GlanceLayoutEntry,
  type GlanceModuleId,
  type GlanceModuleOptions,
  type GlanceModuleSize,
  type GlancePanelSettings,
  type GlancePresetId,
  type GlanceWidthStep,
} from "@/types/glance/layout"

import { effectiveSize, glanceModule, GLANCE_MODULES } from "./registry"

/** The visible entries of each preset, in order. Everything else is hidden. */
export const GLANCE_PRESETS: Readonly<
  Record<GlancePresetId, ReadonlyArray<readonly [GlanceModuleId, GlanceModuleSize]>>
> = {
  balanced: [
    ["fleet", "standard"],
    ["usage", "standard"],
    ["quota", "standard"],
    ["agenda", "compact"],
    ["activity", "standard"],
    ["quick", "compact"],
  ],
  "usage-first": [
    ["usage", "expanded"],
    ["quota", "expanded"],
    ["activity", "expanded"],
    ["fleet", "compact"],
    ["quick", "compact"],
  ],
  "agent-ops": [
    ["fleet", "expanded"],
    ["agenda", "standard"],
    ["recents", "standard"],
    ["quota", "compact"],
    ["quick", "standard"],
  ],
  minimal: [
    ["fleet", "compact"],
    ["usage", "compact"],
    ["quick", "compact"],
  ],
}

/** i18n keys (under `glance`) for the preset names. */
export const GLANCE_PRESET_LABEL_KEYS: Readonly<Record<GlancePresetId, string>> = {
  balanced: "presets.balanced",
  "usage-first": "presets.usageFirst",
  "agent-ops": "presets.agentOps",
  minimal: "presets.minimal",
}

/** A full entry list for a preset: its visible entries, then the rest hidden. */
export function layoutFromPreset(preset: GlancePresetId): GlanceLayoutEntry[] {
  const visible = GLANCE_PRESETS[preset].map(([id, size]) => ({ id, size, hidden: false }))
  const rest = GLANCE_MODULE_IDS.filter((id) => !visible.some((entry) => entry.id === id)).map(
    (id) => ({ id, size: GLANCE_MODULES[id].sizes[0], hidden: true })
  )
  return [...visible, ...rest]
}

export const DEFAULT_GLANCE_PANEL_SETTINGS: GlancePanelSettings = {
  version: 1,
  preset: "balanced",
  entries: layoutFromPreset("balanced"),
  width: "standard",
  maxHeight: GLANCE_MAX_HEIGHT_DEFAULT,
  scope: "all",
  showDelegate: true,
  autofocusDelegate: false,
  options: DEFAULT_GLANCE_MODULE_OPTIONS,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Repair an entry list against the current catalogue. */
export function normalizeEntries(raw: unknown): GlanceLayoutEntry[] {
  if (!Array.isArray(raw)) return layoutFromPreset("balanced")
  const seen = new Set<GlanceModuleId>()
  const out: GlanceLayoutEntry[] = []
  for (const item of raw) {
    if (!isRecord(item) || typeof item.id !== "string") continue
    const def = glanceModule(item.id)
    if (!def || seen.has(def.id)) continue
    seen.add(def.id)
    const size =
      typeof item.size === "string" &&
      (GLANCE_MODULE_SIZES as readonly string[]).includes(item.size)
        ? effectiveSize(def.id, item.size as GlanceModuleSize)
        : def.sizes[0]
    out.push({ id: def.id, size, hidden: item.hidden === true })
  }
  for (const id of GLANCE_MODULE_IDS) {
    if (!seen.has(id)) out.push({ id, size: GLANCE_MODULES[id].sizes[0], hidden: true })
  }
  return out
}

/** Clamp a max height; anything non-numeric falls back to the default. */
export function clampMaxHeight(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return GLANCE_MAX_HEIGHT_DEFAULT
  return Math.round(Math.min(GLANCE_MAX_HEIGHT_MAX, Math.max(GLANCE_MAX_HEIGHT_MIN, value)))
}

function normalizeOptions(raw: unknown): GlanceModuleOptions {
  const usage = isRecord(raw) && isRecord(raw.usage) ? raw.usage : {}
  const activity = isRecord(raw) && isRecord(raw.activity) ? raw.activity : {}
  return {
    usage: {
      scope: usage.scope === "all-tools" ? "all-tools" : "cognia",
      showSpend: usage.showSpend === true,
    },
    activity: {
      range:
        typeof activity.range === "string" &&
        (GLANCE_ACTIVITY_RANGES as readonly string[]).includes(activity.range)
          ? (activity.range as GlanceModuleOptions["activity"]["range"])
          : DEFAULT_GLANCE_MODULE_OPTIONS.activity.range,
    },
  }
}

/** Read whatever is stored into a valid settings object. Never throws. */
export function normalizeGlancePanelSettings(raw: unknown): GlancePanelSettings {
  if (!isRecord(raw)) return DEFAULT_GLANCE_PANEL_SETTINGS
  const preset =
    raw.preset === "custom" ||
    (typeof raw.preset === "string" &&
      (GLANCE_PRESET_IDS as readonly string[]).includes(raw.preset))
      ? (raw.preset as GlancePanelSettings["preset"])
      : DEFAULT_GLANCE_PANEL_SETTINGS.preset
  return {
    version: 1,
    preset,
    entries:
      raw.entries === undefined ? layoutFromPreset("balanced") : normalizeEntries(raw.entries),
    width:
      typeof raw.width === "string" && (GLANCE_WIDTH_STEPS as readonly string[]).includes(raw.width)
        ? (raw.width as GlanceWidthStep)
        : DEFAULT_GLANCE_PANEL_SETTINGS.width,
    maxHeight: clampMaxHeight(raw.maxHeight),
    scope: raw.scope === "workspace" ? "workspace" : "all",
    // Shown unless explicitly turned off: layouts stored before the switch
    // existed keep the bar they had.
    showDelegate: raw.showDelegate !== false,
    autofocusDelegate: raw.autofocusDelegate === true,
    options: normalizeOptions(raw.options),
  }
}

/** The ids currently visible, in render order. */
export function visibleModuleIds(entries: readonly GlanceLayoutEntry[]): GlanceModuleId[] {
  return entries.filter((entry) => !entry.hidden).map((entry) => entry.id)
}
