"use client"

import { useEffect, useState } from "react"
import { NextIntlClientProvider } from "next-intl"

import { defaultLocale, locales, type Locale } from "@/i18n/config"
import { defaultMessages, loadMessages, type Messages } from "@/i18n/messages"
import { useSettingsStore } from "@/stores/settings"
import { getPref } from "@/lib/tauri/store"

export const LIGHTWEIGHT_LOCALE_PREF = "appearance.locale"

function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (locales as readonly string[]).includes(value)
}

/**
 * Locale provider for least-privilege overlays. Imports no account / plugin /
 * notification runtime.
 *
 * Two sources, in this order:
 *   1. the hydrated settings store, which is the same answer the full
 *      `LocaleGate` gives and the only one that works off Tauri (`getPref`
 *      returns null in a browser, so `/status` and the Capacitor shell would
 *      otherwise be pinned to `defaultLocale` whatever the user chose), and
 *   2. the mirrored Tauri pref, which resolves before Dexie does and so keeps
 *      a desktop overlay from painting one frame of English first.
 */
export function LightweightLocaleGate({ children }: { children: React.ReactNode }) {
  const storedLanguage = useSettingsStore((s) => s.settings?.language)
  const settingsLoaded = useSettingsStore((s) => s.loaded)
  const [mirroredLocale, setMirroredLocale] = useState<Locale | null>(null)
  const [messages, setMessages] = useState<Messages>(defaultMessages)
  const locale: Locale =
    settingsLoaded && isLocale(storedLanguage) ? storedLanguage : (mirroredLocale ?? defaultLocale)

  useEffect(() => {
    let alive = true
    void getPref<Locale>(LIGHTWEIGHT_LOCALE_PREF).then((saved) => {
      if (alive && isLocale(saved)) setMirroredLocale(saved)
    })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    if (locale === defaultLocale) return
    let alive = true
    void loadMessages(locale)
      .then((loaded) => {
        if (alive) setMessages(loaded)
      })
      .catch(() => {
        if (alive) setMessages(defaultMessages)
      })
    return () => {
      alive = false
    }
  }, [locale])

  return (
    <NextIntlClientProvider locale={locale} messages={messages} timeZone="UTC">
      {children}
    </NextIntlClientProvider>
  )
}

export default LightweightLocaleGate
