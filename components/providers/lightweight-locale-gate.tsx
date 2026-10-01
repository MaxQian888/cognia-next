"use client"

import { useMemo } from "react"
import { NextIntlClientProvider } from "next-intl"
import { startupMessages } from "@/i18n/messages"
import { useAppLocaleState } from "@/hooks/ui/use-app-locale"
import { useSettingsStore } from "@/stores/settings"
import { resolveFormattingTimeZone } from "@/lib/profile/timezone"
import { LocaleReadyContext } from "./full-messages-gate"

export const LIGHTWEIGHT_LOCALE_PREF = "appearance.locale"

/** Locale shell for overlays; no account, plugin or notification runtime. */
export function LightweightLocaleGate({ children }: { children: React.ReactNode }) {
  const { locale, ready } = useAppLocaleState()
  const loaded = useSettingsStore((s) => s.loaded)
  const profileTimeZone = useSettingsStore((s) => s.settings?.profile?.timezone)
  const timeZone = useMemo(
    () => (loaded ? resolveFormattingTimeZone({ timezone: profileTimeZone }) : "UTC"),
    [loaded, profileTimeZone]
  )
  return (
    <NextIntlClientProvider locale={locale} messages={startupMessages[locale]} timeZone={timeZone}>
      <LocaleReadyContext.Provider value={ready && loaded}>{children}</LocaleReadyContext.Provider>
    </NextIntlClientProvider>
  )
}

export default LightweightLocaleGate
