/**
 * i18n configuration shared between the app shell and the plugin i18n API.
 *
 * cognia-next uses `next-intl` for locale negotiation; the canonical
 * locale list lives in this file. The plugin runtime imports `locales`
 * to validate plugin-contributed locale codes and `localeNames` to
 * show human-readable labels in the language picker.
 */

export const locales = ["en", "zh-CN"] as const

export type Locale = (typeof locales)[number]

export const defaultLocale: Locale = "en"

export const localeNames: Record<Locale, string> = {
  en: "English",
  "zh-CN": "简体中文",
}

/** Predicate guard — narrows an arbitrary string to `Locale`. */
export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (locales as readonly string[]).includes(value)
}
