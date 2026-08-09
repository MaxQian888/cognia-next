/**
 * Tab appearance customization — preset colors and icon catalog.
 *
 * Colors map to Tailwind utility classes (border, background dot).
 * Icons map to lucide-react component names.
 *
 * The store holds the enum key (e.g. `"red"`, `"database"`); the
 * component layer resolves it to a class or a component reference.
 */

/** Preset color keys. `"none"` means "use default status color". */
export const TAB_COLOR_PRESETS = [
  "none",
  "red",
  "orange",
  "yellow",
  "green",
  "cyan",
  "blue",
  "purple",
  "pink",
] as const

export type TabColorPreset = (typeof TAB_COLOR_PRESETS)[number]

/**
 * Tailwind classes for each preset, applied as a left-border accent on the tab.
 * `"none"` returns an empty string so no override is applied.
 */
export const TAB_COLOR_CLASSES: Record<TabColorPreset, { border: string; dot: string }> = {
  none: { border: "", dot: "" },
  red: { border: "border-l-red-500", dot: "bg-red-500" },
  orange: { border: "border-l-orange-500", dot: "bg-orange-500" },
  yellow: { border: "border-l-yellow-500", dot: "bg-yellow-500" },
  green: { border: "border-l-green-500", dot: "bg-green-500" },
  cyan: { border: "border-l-cyan-500", dot: "bg-cyan-500" },
  blue: { border: "border-l-blue-500", dot: "bg-blue-500" },
  purple: { border: "border-l-purple-500", dot: "bg-purple-500" },
  pink: { border: "border-l-pink-500", dot: "bg-pink-500" },
}

/** Icon keys supported in the tab icon picker. */
export const TAB_ICON_PRESETS = [
  "none",
  "terminal",
  "server",
  "database",
  "globe",
  "code",
  "bug",
  "rocket",
  "container",
] as const

export type TabIconPreset = (typeof TAB_ICON_PRESETS)[number]

/** Combined appearance setting. */
export interface TabAppearance {
  color: TabColorPreset
  icon: TabIconPreset
}

/** Default appearance (no customization). */
export const DEFAULT_TAB_APPEARANCE: TabAppearance = {
  color: "none",
  icon: "none",
}

/** Validate a color key. Returns `"none"` for unknown values. */
export function normalizeTabColor(value: unknown): TabColorPreset {
  if (typeof value === "string" && TAB_COLOR_PRESETS.includes(value as TabColorPreset)) {
    return value as TabColorPreset
  }
  return "none"
}

/** Validate an icon key. Returns `"none"` for unknown values. */
export function normalizeTabIcon(value: unknown): TabIconPreset {
  if (typeof value === "string" && TAB_ICON_PRESETS.includes(value as TabIconPreset)) {
    return value as TabIconPreset
  }
  return "none"
}

/** Resolve border class for a given color preset. */
export function tabColorBorderClass(color: TabColorPreset): string {
  return TAB_COLOR_CLASSES[color]?.border ?? ""
}

/** Resolve dot class for a given color preset. */
export function tabColorDotClass(color: TabColorPreset): string {
  return TAB_COLOR_CLASSES[color]?.dot ?? ""
}
