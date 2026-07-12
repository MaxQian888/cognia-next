// Locale-aware display text for plugin-contributed pet content (shop items,
// achievements). Plugin defs carry plain per-locale label/description records
// (`labels: { en: "...", "zh-CN": "..." }`), NOT host i18n keys — the shop /
// achievements tabs resolve them through these helpers and fall back to the
// host `t()` path for static catalog entries (id without the `plugin:` prefix).

import { getPluginItemDisplay } from "@/lib/plugin/registries/pet-item-registry"
import { getPluginAchievementDisplay } from "@/lib/plugin/registries/pet-achievement-registry"

export interface PluginDisplayText {
  title: string
  description: string | null
}

/**
 * Pick the best label for `locale` from a plugin's per-locale record:
 * exact tag → base language ("zh-CN" → "zh") → "en" (required by the
 * manifest contract) → undefined when the record itself is absent.
 */
export function pickLocalized(
  record: Record<string, string> | undefined,
  locale: string
): string | undefined {
  if (!record) return undefined
  const base = locale.split("-")[0]
  return record[locale] ?? record[base] ?? record.en
}

/** True when a catalog/achievement id belongs to a plugin contribution. */
export function isPluginPetId(id: string): boolean {
  return id.startsWith("plugin:")
}

/**
 * Display text for a plugin shop item id, or undefined for static-catalog ids
 * (callers then use the host i18n key path) and unregistered plugin ids
 * (plugin disabled after purchase — callers show the raw local id).
 */
export function pluginItemText(id: string, locale: string): PluginDisplayText | undefined {
  const display = getPluginItemDisplay(id)
  if (!display) return undefined
  return {
    title: pickLocalized(display.def.labels, locale) ?? display.def.id,
    description: pickLocalized(display.def.descriptions, locale) ?? null,
  }
}

/** Display text for a plugin achievement id (same contract as items). */
export function pluginAchievementText(id: string, locale: string): PluginDisplayText | undefined {
  const display = getPluginAchievementDisplay(id)
  if (!display) return undefined
  return {
    title: pickLocalized(display.def.labels, locale) ?? display.def.id,
    description: pickLocalized(display.def.descriptions, locale) ?? null,
  }
}
