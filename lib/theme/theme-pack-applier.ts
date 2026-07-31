// Theme-pack applier (ADR-0029/0030 — P6, the piece that never shipped).
//
// A plugin `themePacks[i]` is a single applyable bundle whose `applies` map
// references other contributions (a theme, font families, a wallpaper, a
// density level/preset, radius, motion). `theme-pack-registry.ts` stores the
// metadata; THIS module resolves one pack into the appearance settings writes
// + runtime DOM effects, mirroring what the individual appearance tabs do
// when a user picks each value by hand.
//
// Deliberately appearance-scoped: `applies.monacoTheme` is NOT applied here —
// the Monaco editor theme lives in the canvas subsystem, which the appearance
// `save()` doesn't drive. It is reported in `skipped` so callers can surface
// "the canvas editor consumes this when opened" without the applier reaching
// across subsystems. (Locked decision, 2026-05-30.)

import type { RegisteredThemePack } from "@/lib/theme/theme-pack-registry"
import type { PluginTheme } from "@/lib/theme/theme-registry"
import type { CustomTheme, ThemeColors } from "@/types/plugin/plugin"
import {
  DEFAULT_DENSITY,
  DEFAULT_MOTION,
  DEFAULT_RADIUS,
  DEFAULT_TYPOGRAPHY_EXT,
  type DensitySettings,
  type MotionSpeed,
  type RadiusSettings,
  type TypographyExtSettings,
} from "@/types/appearance"
import { COLOR_PRESETS } from "@/lib/themes"
import { deriveOppositeVariant } from "@/lib/appearance/derive-variant"
import { applyDensityPresetVars } from "@/lib/appearance/density-applier"

/** Current appearance settings the applier needs to merge into (not mutate). */
export interface ThemePackSettingsSnapshot {
  typographyExt?: Partial<TypographyExtSettings>
  radius?: Partial<RadiusSettings>
  motion?: { speed?: MotionSpeed }
  density?: DensitySettings
  customThemes?: CustomTheme[]
}

export interface ThemePackApplyDeps {
  settings: ThemePackSettingsSnapshot
  /** Plugin themes registry snapshot (`listPluginThemes()`). */
  pluginThemes: PluginTheme[]
  /** Partial settings persister (`useSettingsStore.save`). */
  save: (patch: Record<string, unknown>) => void | Promise<void>
  setActiveWallpaper: (id: string) => void | Promise<void>
  setActiveCustomTheme: (id: string | null) => void | Promise<void>
  createCustomTheme: (seed: Omit<CustomTheme, "id">) => string
  /** Injected for tests; defaults to the real DOM-var applier. */
  applyDensityPreset?: (name: string) => boolean
}

export interface ThemePackApplyResult {
  /** Field tags successfully applied (e.g. "theme:preset", "fonts", "density:level"). */
  applied: string[]
  /** Fields that could not be applied, with a reason. */
  skipped: Array<{ field: string; reason: string }>
}

const DENSITY_LEVELS = new Set(["compact", "comfortable", "spacious"])

/**
 * Resolve `applies.themeId`. It may name a host colour preset (default / ocean
 * / …) or a plugin-contributed theme id. Colour presets persist via
 * `save({ colorTheme })`; plugin themes are cloned into a persistent
 * CustomTheme (reusing an existing clone) and activated — exactly the
 * `theme-tab.tsx:handleSelect` flow, so a pack-applied theme survives plugin
 * disable identically to a hand-picked one.
 */
function applyThemeId(
  themeId: string,
  pack: RegisteredThemePack,
  deps: ThemePackApplyDeps
): string {
  if ((COLOR_PRESETS as readonly string[]).includes(themeId)) {
    void deps.save({ colorTheme: themeId })
    void deps.setActiveCustomTheme(null)
    return "theme:preset"
  }
  const pt = deps.pluginThemes.find(
    (p) =>
      p.id === themeId ||
      p.id === `${pack.pluginId}:${themeId}` ||
      (p.pluginId === pack.pluginId && p.name === themeId)
  )
  if (!pt?.colors) return ""
  const existing = (deps.settings.customThemes ?? []).find(
    (ct) => ct.sourcePluginId === pt.pluginId && ct.name === pt.name
  )
  if (existing) {
    void deps.setActiveCustomTheme(existing.id)
    return "theme:plugin"
  }
  const baseVariant: "light" | "dark" = pt.isDark ? "dark" : "light"
  const opposite: "light" | "dark" = baseVariant === "dark" ? "light" : "dark"
  const tokens = {
    [baseVariant]: pt.colors,
    [opposite]: deriveOppositeVariant(pt.colors, baseVariant),
  } as { light: ThemeColors; dark: ThemeColors }
  const id = deps.createCustomTheme({
    name: pt.name,
    baseVariant,
    derivedVariant: opposite,
    tokens,
    isDark: baseVariant === "dark",
    colors: pt.colors,
    sourcePluginId: pt.pluginId,
  })
  void deps.setActiveCustomTheme(id)
  return "theme:plugin"
}

/** Apply a single theme pack. Pure dispatch over `pack.applies` → settings writes. */
export function applyThemePack(
  pack: RegisteredThemePack,
  deps: ThemePackApplyDeps
): ThemePackApplyResult {
  const a = pack.applies
  const applied: string[] = []
  const skipped: Array<{ field: string; reason: string }> = []

  if (a.themeId) {
    const tag = applyThemeId(a.themeId, pack, deps)
    if (tag) applied.push(tag)
    else skipped.push({ field: "themeId", reason: "unresolved" })
  }

  const fontPatch: Partial<TypographyExtSettings> = {}
  if (a.fontFamily) fontPatch.fontFamily = a.fontFamily
  if (a.monoFamily) fontPatch.monoFamily = a.monoFamily
  if (a.serifFamily) fontPatch.serifFamily = a.serifFamily
  if (Object.keys(fontPatch).length > 0) {
    void deps.save({
      typographyExt: {
        ...DEFAULT_TYPOGRAPHY_EXT,
        ...(deps.settings.typographyExt ?? {}),
        ...fontPatch,
      },
    })
    applied.push("fonts")
  }

  if (a.wallpaperId) {
    // Wallpaper contributions register as `plugin-<pluginId>-<contributionId>`
    // (see wallpaper-bridge.contributionToWallpaper), so namespace the ref.
    void deps.setActiveWallpaper(`plugin-${pack.pluginId}-${a.wallpaperId}`)
    applied.push("wallpaper")
  }

  if (a.density) {
    if (DENSITY_LEVELS.has(a.density)) {
      void deps.save({
        density: { ...DEFAULT_DENSITY, ...(deps.settings.density ?? {}), global: a.density },
      })
      applied.push("density:level")
    } else {
      const applyPreset = deps.applyDensityPreset ?? applyDensityPresetVars
      if (applyPreset(a.density)) applied.push("density:preset")
      else skipped.push({ field: "density", reason: "unknown-preset" })
    }
  }

  if (typeof a.radius === "number") {
    void deps.save({
      radius: {
        ...DEFAULT_RADIUS,
        ...(deps.settings.radius ?? {}),
        base: Math.max(0, Math.min(1.5, a.radius)),
      },
    })
    applied.push("radius")
  }

  if (a.motionSpeed) {
    void deps.save({
      motion: { ...DEFAULT_MOTION, ...(deps.settings.motion ?? {}), speed: a.motionSpeed },
    })
    applied.push("motion")
  }

  if (a.monacoTheme) {
    // Appearance-scoped applier: the Monaco editor theme is owned by the
    // canvas subsystem and consumed when the editor opens.
    skipped.push({ field: "monacoTheme", reason: "canvas-subsystem-owned" })
  }

  return { applied, skipped }
}
