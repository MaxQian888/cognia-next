"use client"

/**
 * Plugin-local translator (sre-agent / pet-daily-quests precedent). Reads the
 * active app locale via next-intl's `useLocale` and looks strings up in this
 * plugin's own bundle — independent of when the manager merges
 * `manifest.i18n.locales` into the host tree. Keys are BARE (`"panel.title"`):
 * the bundle stores them unprefixed because the manager adds the
 * `plugin.<id>.` prefix itself on merge. Falls back to English, then to the
 * raw key, and supports `{var}` interpolation.
 */

import { useLocale } from "next-intl"
import { I18N_MESSAGES } from "./i18n"

type Locale = keyof typeof I18N_MESSAGES
const EN = I18N_MESSAGES.en as Record<string, string>

export type PluginTranslate = (key: string, vars?: Record<string, string | number>) => string

/** Pure lookup — the part tests and non-React call sites use. */
export function translate(
  locale: string,
  key: string,
  vars?: Record<string, string | number>
): string {
  const bundle = (I18N_MESSAGES[locale as Locale] ?? I18N_MESSAGES.en) as Record<string, string>
  const template = bundle[key] ?? EN[key] ?? key
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = vars[name]
    return value === undefined ? match : String(value)
  })
}

export function usePluginT(): PluginTranslate {
  const locale = useLocale()
  return (key, vars) => translate(locale, key, vars)
}
