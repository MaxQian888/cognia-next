/**
 * Plugin i18n Loader
 *
 * Handles loading and managing plugin localization resources.
 */

import { loggers } from "../core/logger"
import { readTextFile } from "@/lib/file/file-operations"

// =============================================================================
// Types
// =============================================================================

export interface PluginLocale {
  pluginId: string
  locale: string
  translations: Record<string, string>
  loadedAt: Date
}

export interface LocaleResource {
  locale: string
  path: string
  namespace?: string
}

export interface I18nConfig {
  defaultLocale: string
  fallbackLocale: string
  loadOnDemand: boolean
  cacheTranslations: boolean
  interpolationPrefix: string
  interpolationSuffix: string
}

export interface TranslationOptions {
  defaultValue?: string
  interpolation?: Record<string, string | number>
  count?: number
  context?: string
}

// =============================================================================
// Plugin i18n Loader
// =============================================================================

export class PluginI18nLoader {
  private config: I18nConfig
  private loadedLocales: Map<string, Map<string, PluginLocale>> = new Map()
  private currentLocale: string
  private listeners: Set<(locale: string) => void> = new Set()

  constructor(config: Partial<I18nConfig> = {}) {
    this.config = {
      defaultLocale: "en",
      fallbackLocale: "en",
      loadOnDemand: true,
      cacheTranslations: true,
      interpolationPrefix: "{{",
      interpolationSuffix: "}}",
      ...config,
    }
    this.currentLocale = this.config.defaultLocale
  }

  // ===========================================================================
  // Locale Loading
  // ===========================================================================

  async loadPluginLocales(pluginId: string, pluginPath: string, locales?: string[]): Promise<void> {
    const targetLocales = locales || [this.currentLocale, this.config.fallbackLocale]

    for (const locale of targetLocales) {
      if (this.hasLocale(pluginId, locale)) continue

      try {
        const translations = await this.loadLocaleFile(pluginPath, locale)
        if (translations) {
          this.setPluginLocale(pluginId, locale, translations)
        }
      } catch (error) {
        loggers.manager.debug(`[I18n] No ${locale} translations for ${pluginId}:`, error)
      }
    }
  }

  private async loadLocaleFile(
    pluginPath: string,
    locale: string
  ): Promise<Record<string, string> | null> {
    try {
      // Try different file patterns
      const patterns = [
        `${pluginPath}/locales/${locale}.json`,
        `${pluginPath}/i18n/${locale}.json`,
        `${pluginPath}/lang/${locale}.json`,
        `${pluginPath}/locales/${locale}/messages.json`,
      ]

      for (const pattern of patterns) {
        try {
          // `readTextFile` throws when the file is missing; treat any
          // empty/whitespace-only payload as a miss too so the next
          // candidate path gets a chance.
          const content = await readTextFile(pattern)
          if (!content || !content.trim()) {
            continue
          }
          return JSON.parse(content)
        } catch {
          // Try next pattern
        }
      }

      return null
    } catch {
      return null
    }
  }

  private setPluginLocale(
    pluginId: string,
    locale: string,
    translations: Record<string, string>
  ): void {
    if (!this.loadedLocales.has(pluginId)) {
      this.loadedLocales.set(pluginId, new Map())
    }

    this.loadedLocales.get(pluginId)!.set(locale, {
      pluginId,
      locale,
      translations,
      loadedAt: new Date(),
    })
  }

  // ===========================================================================
  // Translation
  // ===========================================================================

  translate(pluginId: string, key: string, options: TranslationOptions = {}): string {
    // Try current locale
    let translation = this.getTranslation(pluginId, this.currentLocale, key, options)
    if (translation !== undefined) {
      return this.interpolate(translation, options.interpolation)
    }

    // Try fallback locale
    if (this.currentLocale !== this.config.fallbackLocale) {
      translation = this.getTranslation(pluginId, this.config.fallbackLocale, key, options)
      if (translation !== undefined) {
        return this.interpolate(translation, options.interpolation)
      }
    }

    // Return default value or key
    return options.defaultValue || key
  }

  private getTranslation(
    pluginId: string,
    locale: string,
    key: string,
    options: TranslationOptions
  ): string | undefined {
    const pluginLocales = this.loadedLocales.get(pluginId)
    if (!pluginLocales) return undefined

    const localeData = pluginLocales.get(locale)
    if (!localeData) return undefined

    // Handle context
    if (options.context) {
      const contextKey = `${key}_${options.context}`
      if (localeData.translations[contextKey]) {
        return localeData.translations[contextKey]
      }
    }

    // Handle pluralization
    if (options.count !== undefined) {
      const pluralKey = this.getPluralKey(key, options.count, locale)
      if (localeData.translations[pluralKey]) {
        return localeData.translations[pluralKey]
      }
    }

    return localeData.translations[key]
  }

  private getPluralKey(key: string, count: number, _locale: string): string {
    // Simplified plural rules (would need full CLDR rules for production)
    if (count === 0) {
      return `${key}_zero`
    } else if (count === 1) {
      return `${key}_one`
    } else {
      return `${key}_other`
    }
  }

  private interpolate(text: string, values?: Record<string, string | number>): string {
    if (!values) return text

    const { interpolationPrefix, interpolationSuffix } = this.config
    let result = text

    for (const [key, value] of Object.entries(values)) {
      const pattern = `${interpolationPrefix}${key}${interpolationSuffix}`
      result = result.split(pattern).join(String(value))
    }

    return result
  }

  // ===========================================================================
  // Locale Management
  // ===========================================================================

  setLocale(locale: string): void {
    if (this.currentLocale !== locale) {
      this.currentLocale = locale
      this.notifyListeners(locale)
    }
  }

  getLocale(): string {
    return this.currentLocale
  }

  hasLocale(pluginId: string, locale: string): boolean {
    return this.loadedLocales.get(pluginId)?.has(locale) || false
  }

  getLoadedLocales(pluginId: string): string[] {
    const pluginLocales = this.loadedLocales.get(pluginId)
    if (!pluginLocales) return []
    return Array.from(pluginLocales.keys())
  }

  // ===========================================================================
  // Change Listeners
  // ===========================================================================

  onLocaleChange(listener: (locale: string) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notifyListeners(locale: string): void {
    for (const listener of this.listeners) {
      try {
        listener(locale)
      } catch (error) {
        loggers.manager.error("[I18n] Listener error:", error)
      }
    }
  }

  // ===========================================================================
  // Plugin API Factory
  // ===========================================================================

  createPluginAPI(pluginId: string): PluginI18nAPI {
    return {
      t: (key: string, options?: TranslationOptions) => this.translate(pluginId, key, options),

      getLocale: () => this.currentLocale,

      hasKey: (key: string) => {
        const translations = this.loadedLocales.get(pluginId)?.get(this.currentLocale)?.translations
        return translations ? key in translations : false
      },

      getLoadedLocales: () => this.getLoadedLocales(pluginId),

      onLocaleChange: (listener: (locale: string) => void) => this.onLocaleChange(listener),
    }
  }

  // ===========================================================================
  // Cleanup
  // ===========================================================================

  unloadPlugin(pluginId: string): void {
    this.loadedLocales.delete(pluginId)
  }

  clear(): void {
    this.loadedLocales.clear()
    this.listeners.clear()
  }
}

// =============================================================================
// Plugin i18n API Type
// =============================================================================

export interface PluginI18nAPI {
  t: (key: string, options?: TranslationOptions) => string
  getLocale: () => string
  hasKey: (key: string) => boolean
  getLoadedLocales: () => string[]
  onLocaleChange: (listener: (locale: string) => void) => () => void
}

// =============================================================================
// Singleton Instance
// =============================================================================

let i18nLoaderInstance: PluginI18nLoader | null = null

export function getPluginI18nLoader(config?: Partial<I18nConfig>): PluginI18nLoader {
  if (!i18nLoaderInstance) {
    i18nLoaderInstance = new PluginI18nLoader(config)
  }
  return i18nLoaderInstance
}

export function resetPluginI18nLoader(): void {
  if (i18nLoaderInstance) {
    i18nLoaderInstance.clear()
    i18nLoaderInstance = null
  }
}
