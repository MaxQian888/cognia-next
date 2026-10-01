"use client"

import { useMemo, useSyncExternalStore } from "react"
import { NextIntlClientProvider, type AbstractIntlMessages } from "next-intl"
import type { Locale } from "@/i18n/config"
import { useSettingsStore } from "@/stores/settings"
import { startupMessages } from "@/i18n/messages"
import { useAppLocaleState } from "@/hooks/ui/use-app-locale"
import {
  getMergedPluginMessages,
  getPluginI18nSnapshot,
  inflateFlatKeys,
  subscribeToPluginI18n,
} from "@/lib/i18n/plugin-i18n-registry"
import { resolveFormattingTimeZone } from "@/lib/profile/timezone"
import { FullMessagesGate, LocaleReadyContext } from "./full-messages-gate"

function usePluginMessages() {
  const version = useSyncExternalStore(subscribeToPluginI18n, getPluginI18nSnapshot, () => 0)
  return useMemo(() => {
    void version
    const merged = getMergedPluginMessages()
    return {
      en: inflateFlatKeys(merged.en ?? {}),
      "zh-CN": inflateFlatKeys(merged["zh-CN"] ?? {}),
    } as Record<Locale, AbstractIntlMessages>
  }, [version])
}

/** The pre-account shell needs only startup messages, including recovery UI. */
export function LocaleGate({ children }: { children: React.ReactNode }) {
  const { locale, ready } = useAppLocaleState()
  const loaded = useSettingsStore((s) => s.loaded)
  const profileTimeZone = useSettingsStore((s) => s.settings?.profile?.timezone)
  const timeZone = useMemo(
    () => (loaded ? resolveFormattingTimeZone({ timezone: profileTimeZone }) : "UTC"),
    [loaded, profileTimeZone]
  )
  const pluginMessages = usePluginMessages()
  const messages = useMemo(
    () => ({ ...startupMessages[locale], ...pluginMessages[locale] }),
    [locale, pluginMessages]
  )
  return (
    <NextIntlClientProvider locale={locale} messages={messages} timeZone={timeZone}>
      <LocaleReadyContext.Provider value={ready}>{children}</LocaleReadyContext.Provider>
    </NextIntlClientProvider>
  )
}

/** The full app and anonymous share viewer opt into their chosen full catalog. */
export function FullLocaleGate({
  children,
  waitForSettings = false,
}: {
  children: React.ReactNode
  waitForSettings?: boolean
}) {
  const pluginMessages = usePluginMessages()
  const loaded = useSettingsStore((s) => s.loaded)
  return (
    <FullMessagesGate ready={!waitForSettings || loaded} additionalMessages={pluginMessages}>
      {children}
    </FullMessagesGate>
  )
}
