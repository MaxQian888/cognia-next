"use client"

/**
 * Plugin-local translator. Reads the active app locale via next-intl's
 * `useLocale` (reliable under the app's NextIntlClientProvider) and looks up
 * strings in this plugin's own i18n bundle — independent of however the plugin
 * manager merges `manifest.i18n.locales` into the host message tree. Keys are
 * passed unprefixed (e.g. `"review.title"`); the helper adds the
 * `plugin.<pluginId>.` prefix the bundle is keyed by, and falls back to English
 * then to the raw key. Supports `{var}` interpolation.
 */

import { useLocale } from "next-intl"
import { I18N_MESSAGES } from "../i18n"
import { PLUGIN_ID } from "../ids"

type Locale = keyof typeof I18N_MESSAGES
const PREFIX = `plugin.${PLUGIN_ID}.`
const EN = I18N_MESSAGES.en as Record<string, string>

export type PluginTranslate = (key: string, vars?: Record<string, string>) => string

export function usePluginT(): PluginTranslate {
  const locale = useLocale() as Locale
  const bundle = (I18N_MESSAGES[locale] ?? I18N_MESSAGES.en) as Record<string, string>
  return (key, vars) => {
    const full = `${PREFIX}${key}`
    let s = bundle[full] ?? EN[full] ?? key
    if (vars) {
      for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, v)
    }
    return s
  }
}
