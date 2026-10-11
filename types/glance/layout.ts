/**
 * Pure layout model for glance surfaces (ADR-0225): the desktop tray panel
 * today, the mobile home and Glance drawer from phase 3.
 *
 * Kept free of React and icons, like `@/types/shell/mobile-home`, so
 * `AppSettings` and the persistence layer can import it without pulling a
 * component graph. The module catalogue (labels, icons, owner surfaces) lives
 * in `lib/glance/registry.ts`; presets and normalization in
 * `lib/glance/presets.ts`.
 */

/** Every first-party glance module. Plugin modules are {@link GlancePluginEntryId}s. */
export type GlanceModuleId =
  "fleet" | "usage" | "quota" | "agenda" | "activity" | "quick" | "recents" | "pet"

export const GLANCE_MODULE_IDS: readonly GlanceModuleId[] = [
  "fleet",
  "usage",
  "quota",
  "agenda",
  "activity",
  "quick",
  "recents",
  "pet",
]

/**
 * How much room a module takes. `compact` is one line, `standard` the default
 * body, `expanded` the full detail. A module declares which it supports.
 */
export type GlanceModuleSize = "compact" | "standard" | "expanded"

export const GLANCE_MODULE_SIZES: readonly GlanceModuleSize[] = ["compact", "standard", "expanded"]

/**
 * A plugin module's place in a layout (ADR-0225 §6): `plugin:<pluginId>:<id>`.
 * A layout keeps the entry while the plugin is disabled or uninstalled, so
 * turning it back on restores the module where the user put it; surfaces
 * skip an entry whose module is not available right now.
 */
export type GlancePluginEntryId = `plugin:${string}`

/** What a layout entry names: a first-party module or a plugin module. */
export type GlanceEntryId = GlanceModuleId | GlancePluginEntryId

const PLUGIN_ENTRY = /^plugin:([A-Za-z0-9][A-Za-z0-9._-]{0,127}):([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/

/** True for a well-formed plugin entry id. */
export function isPluginEntryId(id: unknown): id is GlancePluginEntryId {
  return typeof id === "string" && PLUGIN_ENTRY.test(id)
}

/** The entry id of one plugin module. */
export function pluginEntryId(pluginId: string, moduleId: string): GlancePluginEntryId {
  return `plugin:${pluginId}:${moduleId}`
}

/** The plugin and module a plugin entry id names, or null for anything else. */
export function parsePluginEntryId(id: unknown): { pluginId: string; moduleId: string } | null {
  if (typeof id !== "string") return null
  const match = PLUGIN_ENTRY.exec(id)
  return match ? { pluginId: match[1], moduleId: match[2] } : null
}

/** How many plugin entries one layout keeps. */
export const GLANCE_MAX_PLUGIN_ENTRIES = 24

/** One stack entry. Order in the array is render order. */
export interface GlanceLayoutEntry {
  id: GlanceEntryId
  size: GlanceModuleSize
  hidden: boolean
}

/** Built-in starting points. `custom` means the user edited one. */
export type GlancePresetId = "balanced" | "usage-first" | "agent-ops" | "minimal"

export const GLANCE_PRESET_IDS: readonly GlancePresetId[] = [
  "balanced",
  "usage-first",
  "agent-ops",
  "minimal",
]

/** The panel's three widths, in logical px of the panel body. */
export type GlanceWidthStep = "narrow" | "standard" | "wide"

export const GLANCE_WIDTH_STEPS: readonly GlanceWidthStep[] = ["narrow", "standard", "wide"]

export const GLANCE_WIDTH_PX: Readonly<Record<GlanceWidthStep, number>> = {
  narrow: 320,
  standard: 380,
  wide: 460,
}

/** Bounds of the user's max height. The window clamp in Rust is 900. */
export const GLANCE_MAX_HEIGHT_MIN = 240
export const GLANCE_MAX_HEIGHT_MAX = 860
export const GLANCE_MAX_HEIGHT_DEFAULT = 640

/** Whose usage the usage module counts (ADR-0165 §3: all-tools is opt-in). */
export type GlanceUsageScope = "cognia" | "all-tools"

/** Range of the activity heatmap. */
export type GlanceActivityRange = "1m" | "3m" | "1y"

export const GLANCE_ACTIVITY_RANGES: readonly GlanceActivityRange[] = ["1m", "3m", "1y"]

/** Which data the modules read (ADR-0225 §8). */
export type GlanceScope = "all" | "workspace"

/** Per-module options. Absent fields fall back to the defaults. */
export interface GlanceModuleOptions {
  usage: {
    scope: GlanceUsageScope
    /**
     * Show money. Off by default, per ADR-0165 §2: a spend figure is an
     * opt-in readout, and tokens are what every install can show honestly.
     */
    showSpend: boolean
  }
  activity: { range: GlanceActivityRange }
}

/**
 * Persisted shape (`AppSettings.trayPanelLayout`). Versioned so a later shape
 * change can migrate instead of discarding a user's layout.
 */
export interface GlancePanelSettings {
  version: 1
  preset: GlancePresetId | "custom"
  entries: GlanceLayoutEntry[]
  width: GlanceWidthStep
  /** Logical px. Clamped to [GLANCE_MAX_HEIGHT_MIN, GLANCE_MAX_HEIGHT_MAX]. */
  maxHeight: number
  scope: GlanceScope
  /**
   * Show the delegate bar under the stack. Hidden, the primary action joins
   * the quick actions instead, so it stays one click away.
   */
  showDelegate: boolean
  /** Move keyboard focus to the delegate bar whenever the panel opens. */
  autofocusDelegate: boolean
  options: GlanceModuleOptions
}

export const DEFAULT_GLANCE_MODULE_OPTIONS: GlanceModuleOptions = {
  usage: { scope: "cognia", showSpend: false },
  activity: { range: "3m" },
}

/* ── Mobile (ADR-0225 §9, §10) ───────────────────────────────────────── */

/**
 * A mobile stack entry. `home` pins the module to the home screen too: the
 * home renders pinned, visible entries in layout order; the Glance drawer
 * always renders every visible entry. A hidden entry is on neither.
 */
export interface GlanceMobileEntry extends GlanceLayoutEntry {
  home: boolean
}

/**
 * Persisted shape (`AppSettings.mobileGlanceLayout`). One per account: the
 * phone's home screen and Glance drawer. Independent of the desktop's
 * `trayPanelLayout`; either can copy the other's entries.
 *
 * `shortcuts` is the quick module's content on a phone: the ordered ids of the
 * shortcut catalogue (`MOBILE_QUICK_ACTION_CATALOG`), which used to be
 * `mobileHomeLayout.quickActions`.
 */
export interface GlanceMobileSettings {
  version: 1
  preset: GlancePresetId | "custom"
  entries: GlanceMobileEntry[]
  scope: GlanceScope
  options: GlanceModuleOptions
  shortcuts: string[]
}
