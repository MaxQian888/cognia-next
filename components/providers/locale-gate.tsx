"use client"

import { NextIntlClientProvider } from "next-intl"
import { useSettingsStore } from "@/stores/settings"
import { allMessages } from "@/i18n/messages"
import { defaultLocale, type Locale } from "@/i18n/config"

/**
 * Wraps children in a NextIntlClientProvider whose locale is sourced from the
 * persisted user setting. Until the settings store has hydrated we pin to the
 * default locale to avoid hydration mismatches against the server-rendered
 * markup (which uses the static-export default).
 */
export function LocaleGate({ children }: { children: React.ReactNode }) {
  const language = useSettingsStore((s) => s.settings?.language)
  const loaded = useSettingsStore((s) => s.loaded)
  const locale: Locale = loaded && language ? language : defaultLocale

  return (
    <NextIntlClientProvider
      locale={locale}
      messages={allMessages[locale]}
      // App is offline-first; pinning the time zone keeps formatted dates stable.
      timeZone="UTC"
    >
      {children}
    </NextIntlClientProvider>
  )
}
