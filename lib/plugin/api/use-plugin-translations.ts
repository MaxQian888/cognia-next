"use client"

/**
 * `usePluginTranslations` — the React half of `ctx.i18n`.
 *
 * A plugin's React components (tool-result cards, message-part renderers, slot
 * contributions) receive no `ctx`, so before this hook each plugin found its
 * own way to a translator: two hand-rolled `usePluginT` hooks that read
 * `next-intl` directly (a module the plugin loader does not share, so the same
 * code fails to load as an installed plugin), host `chat.*` namespaces that a
 * third party cannot add keys to, or a module-level `ctx` with a manual
 * re-render on locale change.
 *
 * This hook reads the plugin's own `manifest.i18n.locales` bundle through the
 * same lookup as `ctx.i18n.t` (active locale → English → raw key, `{name}`
 * interpolation) and re-renders when the user switches language or a bundle
 * registers, so a component and its command handler never disagree.
 */

import { useCallback, useSyncExternalStore } from "react"

import { getPluginI18nSnapshot, subscribeToPluginI18n } from "@/lib/i18n/plugin-i18n-registry"
import { useSettingsStore } from "@/stores"
import type { TranslationParams } from "@/types/plugin/plugin"

import { translatePluginMessage } from "./i18n-api"

export type PluginTranslate = (key: string, params?: TranslationParams) => string

/**
 * Translate this plugin's keys inside a React component.
 *
 * Keys are the plugin's own, unprefixed (`"card.title"`); `plugin.<id>.`
 * prefixed keys are accepted too.
 *
 * @example
 *   const t = usePluginTranslations("acme-weather")
 *   return <ToolCard title={t("card.title", { city })} />
 */
export function usePluginTranslations(pluginId: string): PluginTranslate {
  const locale = useSettingsStore((state) => state.language)
  const bundlesVersion = useSyncExternalStore(subscribeToPluginI18n, getPluginI18nSnapshot, () => 0)
  return useCallback(
    (key: string, params?: TranslationParams) => {
      // Read so a bundle (un)registering yields a new translator identity.
      void bundlesVersion
      return translatePluginMessage(pluginId, locale, key, params)
    },
    [pluginId, locale, bundlesVersion]
  )
}
