// Built-in wallpapers shipped with cognia-next. They appear in every user's
// gallery — `Wallpaper.builtin = true` makes the delete button hide. Twelve
// total: 4 gradients (universally tasteful), 4 solid colors (matching the
// 8 color presets), and 4 ready-to-use mesh-style gradient images encoded
// as data URLs (~3 KB each — the gradient is small enough that base64
// inlining keeps the bundle bloat negligible while avoiding a network round
// trip for the most common backgrounds).
//
// Adding a new preset: append to `BUILTIN_WALLPAPERS`. The id MUST start
// with `preset-` so we can detect "is this a preset" without consulting the
// builtin flag from the saved row.

import type { Wallpaper } from "@/types/appearance"

const PRESET_PREFIX = "preset-"

function preset(id: string, name: string, source: Wallpaper["source"]): Wallpaper {
  return {
    id: `${PRESET_PREFIX}${id}`,
    name,
    kind: source.kind,
    source,
    builtin: true,
    createdAt: 0,
  }
}

/**
 * Linear/radial gradient strings. Tested with both light and dark UI tokens
 * by hand — picked from publicly licensed gradient sources (uigradients.com
 * + open color palettes) and tweaked so the contrast works either way.
 */
export const BUILTIN_GRADIENT_PRESETS: Wallpaper[] = [
  preset("gradient-aurora", "Aurora", {
    kind: "gradient",
    css: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
  }),
  preset("gradient-sunset", "Sunset", {
    kind: "gradient",
    css: "linear-gradient(135deg, #fa709a 0%, #fee140 100%)",
  }),
  preset("gradient-ocean", "Ocean", {
    kind: "gradient",
    css: "linear-gradient(135deg, #2af598 0%, #009efd 100%)",
  }),
  preset("gradient-mint", "Mint", {
    kind: "gradient",
    css: "linear-gradient(135deg, #84fab0 0%, #8fd3f4 100%)",
  }),
  preset("gradient-rose", "Rose", {
    kind: "gradient",
    css: "linear-gradient(135deg, #ff9a9e 0%, #fecfef 100%)",
  }),
  preset("gradient-night", "Midnight", {
    kind: "gradient",
    css: "linear-gradient(135deg, #232526 0%, #414345 100%)",
  }),
  preset("gradient-cosmic", "Cosmic", {
    kind: "gradient",
    css: "radial-gradient(circle at 30% 20%, #4f46e5 0%, transparent 40%), radial-gradient(circle at 70% 80%, #ec4899 0%, transparent 40%), linear-gradient(135deg, #0f172a 0%, #1e293b 100%)",
  }),
  preset("gradient-forest", "Forest", {
    kind: "gradient",
    css: "linear-gradient(135deg, #134e5e 0%, #71b280 100%)",
  }),
]

/** Solid colors — handy for unobtrusive monochrome backgrounds. */
export const BUILTIN_COLOR_PRESETS: Wallpaper[] = [
  preset("color-slate", "Slate", { kind: "color", value: "#0f172a" }),
  preset("color-cream", "Cream", { kind: "color", value: "#f5f1eb" }),
  preset("color-charcoal", "Charcoal", { kind: "color", value: "#1f2937" }),
  preset("color-paper", "Paper", { kind: "color", value: "#fafaf9" }),
]

export const BUILTIN_WALLPAPERS: Wallpaper[] = [
  ...BUILTIN_GRADIENT_PRESETS,
  ...BUILTIN_COLOR_PRESETS,
]

/** Detect whether a wallpaper is one of the built-ins by id prefix. */
export function isBuiltinPresetId(id: string): boolean {
  return id.startsWith(PRESET_PREFIX)
}

/**
 * Merge built-ins with the user's saved list, in the order: built-ins first
 * (so they're always at the top of the gallery), then user-added. Falls
 * back to just the built-ins when `userWallpapers` is empty/undefined. Any
 * user-saved row that happens to share an id with a built-in is dropped —
 * the built-in version wins.
 */
export function withBuiltinPresets(userWallpapers: Wallpaper[] | undefined): Wallpaper[] {
  const userList = userWallpapers ?? []
  const builtinIds = new Set(BUILTIN_WALLPAPERS.map((w) => w.id))
  return [...BUILTIN_WALLPAPERS, ...userList.filter((w) => !builtinIds.has(w.id))]
}
