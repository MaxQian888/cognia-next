/**
 * Plugin I18n API Implementation
 *
 * Provides internationalization capabilities to plugins.
 */

import { useSettingsStore } from "@/stores"
import { locales, localeNames, type Locale } from "@/lib/i18n/config"
import type { PluginI18nAPI, TranslationParams } from "@/types/plugin/plugin"
import type { Locale as PluginLocale } from "@/types/plugin/plugin"
import { createPluginSystemLogger } from "../core/logger"

// Plugin translation registrations
const pluginTranslations = new Map<string, Map<Locale, Record<string, string>>>()

/**
 * Create the I18n API for a plugin
 */
export function createI18nAPI(pluginId: string): PluginI18nAPI {
  const logger = createPluginSystemLogger(pluginId)
  // Initialize plugin translation storage
  if (!pluginTranslations.has(pluginId)) {
    pluginTranslations.set(pluginId, new Map())
  }

  const getPluginTranslations = () => pluginTranslations.get(pluginId)!

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

    t: (key: string, params?: TranslationParams): string => {
      const currentLocale = useSettingsStore.getState().language as Locale
      const translations = getPluginTranslations().get(currentLocale)

      if (!translations) {
        return key
      }

      let value = translations[key]
      if (!value) {
        // Fallback to English
        const enTranslations = getPluginTranslations().get("en")
        value = enTranslations?.[key] || key
      }

      // Handle parameter interpolation
      if (params && value !== key) {
        return value.replace(/\{(\w+)\}/g, (match, paramName) => {
          const paramValue = params[paramName]
          return paramValue !== undefined ? String(paramValue) : match
        })
      }

      return value
    },

    registerTranslations: (locale: PluginLocale, translations: Record<string, string>) => {
      const pluginTrans = getPluginTranslations()
      const existing = pluginTrans.get(locale as Locale) || {}
      pluginTrans.set(locale as Locale, { ...existing, ...translations })
      logger.info(`Registered ${Object.keys(translations).length} translations for ${locale}`)
    },

    hasTranslation: (key: string): boolean => {
      const currentLocale = useSettingsStore.getState().language as Locale
      const translations = getPluginTranslations().get(currentLocale)
      return translations?.[key] !== undefined
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
