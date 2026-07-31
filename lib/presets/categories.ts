// Category catalogue for presets. Drives both the editor's category dropdown
// and the section's filter chips. Labels resolve via `next-intl`'s
// `useTranslations("presets")` namespace; the keys here map onto
// `presets.category.<id>` in the i18n message bundles.

import {
  BookOpenIcon,
  BriefcaseIcon,
  Code2Icon,
  FlaskConicalIcon,
  PaletteIcon,
  PenLineIcon,
  SparklesIcon,
  ZapIcon,
  type LucideIcon,
} from "lucide-react"
import type { PresetCategory } from "@cognia/agent-config-types"

export interface PresetCategorySpec {
  id: PresetCategory
  /** i18n key under `presets.category.<labelKey>`. */
  labelKey: PresetCategory
  /** Lucide icon shown in the filter chip and the editor select. */
  icon: LucideIcon
  /** Tailwind text-color class for chip / icon tinting. */
  tone: string
}

export const PRESET_CATEGORIES: readonly PresetCategorySpec[] = [
  { id: "general", labelKey: "general", icon: SparklesIcon, tone: "text-sky-500" },
  { id: "coding", labelKey: "coding", icon: Code2Icon, tone: "text-emerald-500" },
  { id: "writing", labelKey: "writing", icon: PenLineIcon, tone: "text-rose-500" },
  { id: "research", labelKey: "research", icon: FlaskConicalIcon, tone: "text-violet-500" },
  { id: "education", labelKey: "education", icon: BookOpenIcon, tone: "text-amber-500" },
  { id: "business", labelKey: "business", icon: BriefcaseIcon, tone: "text-indigo-500" },
  { id: "creative", labelKey: "creative", icon: PaletteIcon, tone: "text-fuchsia-500" },
  { id: "productivity", labelKey: "productivity", icon: ZapIcon, tone: "text-orange-500" },
] as const

export const PRESET_CATEGORY_IDS: readonly PresetCategory[] = PRESET_CATEGORIES.map((c) => c.id)

export function getCategorySpec(id: PresetCategory | undefined): PresetCategorySpec | undefined {
  if (!id) return undefined
  return PRESET_CATEGORIES.find((c) => c.id === id)
}

/**
 * Resolve the i18n label for a category, with a sensible fallback when
 * `t` returns the key unchanged (i18n bundle missing in tests, etc.).
 */
export function getCategoryLabel(
  t: (key: string) => string,
  id: PresetCategory | undefined
): string {
  if (!id) return t("presets.category.uncategorized")
  const key = `presets.category.${id}`
  const resolved = t(key)
  return resolved === key ? id : resolved
}
