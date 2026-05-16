"use client"

import { useMemo, useSyncExternalStore } from "react"
import { NextIntlClientProvider } from "next-intl"
import { useSettingsStore } from "@/stores/settings"
import { allMessages } from "@/i18n/messages"
import { defaultLocale, type Locale } from "@/i18n/config"
import {
  getMergedPluginMessages,
  getPluginI18nSnapshot,
  inflateFlatKeys,
  subscribeToPluginI18n,
} from "@/lib/i18n/plugin-i18n-registry"

/**
 * Wraps children in a NextIntlClientProvider whose locale is sourced from
 * the persisted user setting and whose messages are the host bundle merged
 * with every enabled plugin's `manifest.i18n.locales` contribution.
 *
 * Plugin messages flow through `lib/i18n/plugin-i18n-registry.ts` — the
 * plugin manager registers them on enable and unregisters them on disable.
 * `useSyncExternalStore` subscribes to the registry's version counter so
 * the provider re-renders (and `useTranslations` callers see the new
 * plugin strings) without a page reload.
 *
 * Until the settings store has hydrated we pin to the default locale to
 * avoid hydration mismatches against the server-rendered markup (which
 * uses the static-export default).
 */
export function LocaleGate({ children }: { children: React.ReactNode }) {
  const language = useSettingsStore((s) => s.settings?.language)
  const loaded = useSettingsStore((s) => s.loaded)
  const locale: Locale = loaded && language ? language : defaultLocale

  // Subscribe to plugin i18n changes — version bumps on every register /
  // unregister so React knows to re-render with the merged messages.
  // Server snapshot returns the initial 0; plugins only enable client-side
  // after hydration so SSR sees the host bundle only, which matches the
  // first client render.
  const pluginVersion = useSyncExternalStore(subscribeToPluginI18n, getPluginI18nSnapshot, () => 0)

  const messages = useMemo(() => {
    // pluginVersion is the invalidation trigger — read it inside the body so
    // ESLint sees the dependency, and so the React compiler doesn't elide it.
    void pluginVersion
    const host = allMessages[locale]
    const merged = getMergedPluginMessages()
    const pluginFlat = merged[locale]
    if (!pluginFlat || Object.keys(pluginFlat).length === 0) {
      return host
    }
    // next-intl expects nested objects — inflate the flat dot-notation keys
    // the plugin registry stores before merging.
    const pluginNested = inflateFlatKeys(pluginFlat)
    return { ...host, ...pluginNested } as typeof host
  }, [locale, pluginVersion])

  return (
    <NextIntlClientProvider
      locale={locale}
      messages={messages}
      // App is offline-first; pinning the time zone keeps formatted dates stable.
      timeZone="UTC"
    >
      {children}
    </NextIntlClientProvider>
  )
}
