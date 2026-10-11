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

/** Every first-party glance module. Plugin modules arrive in phase 4. */
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

/** One stack entry. Order in the array is render order. */
export interface GlanceLayoutEntry {
  id: GlanceModuleId
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
  /** Move keyboard focus to the delegate bar whenever the panel opens. */
  autofocusDelegate: boolean
  options: GlanceModuleOptions
}

export const DEFAULT_GLANCE_MODULE_OPTIONS: GlanceModuleOptions = {
  usage: { scope: "cognia", showSpend: false },
  activity: { range: "3m" },
}
