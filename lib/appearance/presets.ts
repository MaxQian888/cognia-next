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
  // ── 二次元 backgrounds ────────────────────────────────────────────────────
  // Companions to the anime themes in `lib/themes/built-in-themes.ts`. Each is
  // keyed to one theme's surfaces so "pick Sakura, pick Sakura Sky" reads as
  // one look rather than two decisions; they stand on their own too.
  preset("gradient-sakura-sky", "Sakura Sky", {
    kind: "gradient",
    css: "radial-gradient(circle at 20% 15%, #ffd7e6 0%, transparent 45%), radial-gradient(circle at 85% 25%, #ffe9c9 0%, transparent 40%), linear-gradient(160deg, #fff5f8 0%, #ffc9dd 100%)",
  }),
  preset("gradient-neon-city", "Neon City", {
    kind: "gradient",
    css: "radial-gradient(ellipse at 25% 85%, #ff2d95 0%, transparent 45%), radial-gradient(ellipse at 78% 20%, #22d3ee 0%, transparent 42%), linear-gradient(180deg, #0b0a12 0%, #1a1730 100%)",
  }),
  preset("gradient-mahou", "Mahou", {
    kind: "gradient",
    css: "radial-gradient(circle at 70% 25%, #a78bfa 0%, transparent 45%), radial-gradient(circle at 20% 80%, #67e8f9 0%, transparent 40%), linear-gradient(150deg, #14102a 0%, #2b1f5c 100%)",
  }),
  preset("gradient-yozora", "Yozora", {
    kind: "gradient",
    css: "radial-gradient(circle at 80% 12%, #ffd166 0%, transparent 22%), radial-gradient(circle at 30% 40%, #3b5bb5 0%, transparent 50%), linear-gradient(180deg, #0d1330 0%, #060a1e 100%)",
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
