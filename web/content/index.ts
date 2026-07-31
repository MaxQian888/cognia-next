import type { Locale } from "@web/lib/locale"
import { en } from "./en"
import type { SiteCopy } from "./types"
import { zh } from "./zh"

const COPY: Record<Locale, SiteCopy> = { en, zh }

/** The copy bundle for a locale. Both bundles satisfy the same interface. */
export function getCopy(locale: Locale): SiteCopy {
  return COPY[locale]
}

/**
 * Fill `{name}` placeholders. Marketing copy needs interpolation in a handful
 * of places ("Step 2 of 6", "as of 2026-07-26") and nothing more elaborate; a
 * full ICU runtime would be a dependency bought for four call sites.
 */
export function format(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in values ? String(values[key]) : match
  )
}

export type { SiteCopy } from "./types"
