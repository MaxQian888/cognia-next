"use client"

/**
 * Plugin-local translator for plugin React components (which receive no `ctx`).
 * Reads the active app locale via next-intl's `useLocale` and looks up keys in
 * this plugin's own i18n bundle. Keys are UNPREFIXED (`"modal.title"`) — the
 * bundle's raw shape — matching the `manifest.i18n.locales` contract where the
 * host applies the `plugin.<pluginId>.` prefix at merge time. Falls back to
 * English, then to the raw key. Supports `{var}` interpolation.
 *
 * Non-component code (the `/browser` command handler) should prefer
 * `ctx.i18n.t(key)`, which resolves through the host-merged registry.
 */

import { useLocale } from "next-intl"
import { I18N_MESSAGES } from "../i18n"

type Locale = keyof typeof I18N_MESSAGES
const EN = I18N_MESSAGES.en as Record<string, string>

export type PluginTranslate = (key: string, vars?: Record<string, string>) => string

export function usePluginT(): PluginTranslate {
  const locale = useLocale() as Locale
  const bundle = (I18N_MESSAGES[locale] ?? I18N_MESSAGES.en) as Record<string, string>
  return (key, vars) => {
    let s = bundle[key] ?? EN[key] ?? key
    if (vars) {
      for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, v)
    }
    return s
  }
}
