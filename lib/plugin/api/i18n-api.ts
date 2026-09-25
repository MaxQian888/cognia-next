/**
 * Plugin I18n API Implementation
 *
 * Provides internationalization capabilities to plugins.
 */

import { useSettingsStore } from "@/stores"
import { locales, localeNames, type Locale } from "@/lib/i18n/config"
import type { PluginI18nAPI, TranslationParams } from "@/types/plugin/plugin"
import type { Locale as PluginLocale } from "@/types/plugin/plugin"
import {
  getPluginI18nBundle,
  lookupPluginMessage,
  registerPluginI18n,
} from "@/lib/i18n/plugin-i18n-registry"
import { createPluginSystemLogger } from "../core/logger"

/** A plugin's own key, namespaced the way the manager registers its bundle. */
export function pluginMessageKey(pluginId: string, key: string): string {
  return key.startsWith(`plugin.${pluginId}.`) ? key : `plugin.${pluginId}.${key}`
}

/**
 * The one lookup rule for a plugin string: the active locale, then English,
 * then the raw key, with `{name}` interpolation. `ctx.i18n.t` and the
 * `usePluginTranslations` hook both answer through here, so a component and
 * its command handler can never disagree on the same key.
 */
export function translatePluginMessage(
  pluginId: string,
  locale: string,
  key: string,
  params?: TranslationParams
): string {
  const resolvedKey = pluginMessageKey(pluginId, key)
  const value =
    lookupPluginMessage(locale, resolvedKey) ?? lookupPluginMessage("en", resolvedKey) ?? key
  if (!params || value === key) return value
  return value.replace(/\{(\w+)\}/g, (match, paramName: string) => {
    const paramValue = params[paramName]
    return paramValue !== undefined ? String(paramValue) : match
  })
}

/**
 * Create the I18n API for a plugin
 */
export function createI18nAPI(pluginId: string): PluginI18nAPI {
  const logger = createPluginSystemLogger(pluginId)
  const fullKey = (key: string) => pluginMessageKey(pluginId, key)

  return {
    getCurrentLocale: (): PluginLocale => {
      return useSettingsStore.getState().language as PluginLocale
    },

    getAvailableLocales: (): PluginLocale[] => {
      return locales as unknown as PluginLocale[]
    },

    getLocaleName: (locale: PluginLocale): string => {
      return localeNames[locale as Locale] || locale
    },

    t: (key: string, params?: TranslationParams): string =>
      translatePluginMessage(pluginId, useSettingsStore.getState().language, key, params),

    registerTranslations: (locale: PluginLocale, translations: Record<string, string>) => {
      const existing = getPluginI18nBundle(pluginId)?.messages ?? {}
      const localeKey = locale as Locale
      const prefixed = Object.fromEntries(
        Object.entries(translations).map(([key, value]) => [fullKey(key), value])
      )
      registerPluginI18n({
        pluginId,
        messages: {
          ...existing,
          [localeKey]: {
            ...(existing[localeKey] ?? {}),
            ...prefixed,
          },
        },
      })
      logger.info(`Registered ${Object.keys(translations).length} translations for ${locale}`)
    },

    hasTranslation: (key: string): boolean => {
      const currentLocale = useSettingsStore.getState().language as Locale
      return lookupPluginMessage(currentLocale, fullKey(key)) !== undefined
    },

    onLocaleChange: (handler: (locale: PluginLocale) => void) => {
      let lastLocale = useSettingsStore.getState().language

      const unsubscribe = useSettingsStore.subscribe((state) => {
        if (state.language !== lastLocale) {
          lastLocale = state.language
          handler(state.language as PluginLocale)
        }
      })

      return unsubscribe
    },

    formatDate: (date: Date, options?: Intl.DateTimeFormatOptions): string => {
      const locale = useSettingsStore.getState().language
      const localeCode = locale === "zh-CN" ? "zh-CN" : "en-US"
      return new Intl.DateTimeFormat(localeCode, options).format(date)
    },

    formatNumber: (number: number, options?: Intl.NumberFormatOptions): string => {
      const locale = useSettingsStore.getState().language
      const localeCode = locale === "zh-CN" ? "zh-CN" : "en-US"
      return new Intl.NumberFormat(localeCode, options).format(number)
    },

    formatRelativeTime: (date: Date): string => {
      const locale = useSettingsStore.getState().language
      const localeCode = locale === "zh-CN" ? "zh-CN" : "en-US"

      const now = new Date()
      const diffMs = now.getTime() - date.getTime()
      const diffSec = Math.floor(diffMs / 1000)
      const diffMin = Math.floor(diffSec / 60)
      const diffHour = Math.floor(diffMin / 60)
      const diffDay = Math.floor(diffHour / 24)

      const rtf = new Intl.RelativeTimeFormat(localeCode, { numeric: "auto" })

      if (diffDay > 0) {
        return rtf.format(-diffDay, "day")
      } else if (diffHour > 0) {
        return rtf.format(-diffHour, "hour")
      } else if (diffMin > 0) {
        return rtf.format(-diffMin, "minute")
      } else {
        return rtf.format(-diffSec, "second")
      }
    },
  }
}
