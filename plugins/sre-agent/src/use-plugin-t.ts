"use client"

/**
 * Plugin-local translator (strix-security / pet-daily-quests precedent).
 * Reads the active app locale via next-intl's `useLocale` and looks strings up
 * in this plugin's own bundle — independent of how the manager merges
 * `manifest.i18n.locales` into the host tree. Keys are passed unprefixed (e.g.
 * `"panel.title"`); the helper adds the `plugin.sre-agent.` prefix, falls back
 * to English then to the raw key, and supports `{var}` interpolation.
 */

import { useLocale } from "next-intl"
import { I18N_MESSAGES } from "./i18n"
import { PLUGIN_ID } from "./ids"

type Locale = keyof typeof I18N_MESSAGES
const PREFIX = `plugin.${PLUGIN_ID}.`
const EN = I18N_MESSAGES.en as Record<string, string>

export type PluginTranslate = (key: string, vars?: Record<string, string | number>) => string

/** Resolve one key against a locale bundle — exported for non-hook callers/tests. */
export function translate(
  locale: string,
  key: string,
  vars?: Record<string, string | number>
): string {
  const bundle = (I18N_MESSAGES[locale as Locale] ?? I18N_MESSAGES.en) as Record<string, string>
  const full = `${PREFIX}${key}`
  let text = bundle[full] ?? EN[full] ?? key
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.replaceAll(`{${name}}`, String(value))
    }
  }
  return text
}

export function usePluginT(): PluginTranslate {
  const locale = useLocale()
  return (key, vars) => translate(locale, key, vars)
}
