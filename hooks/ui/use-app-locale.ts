"use client"

import { useEffect, useState } from "react"
import { defaultLocale, type Locale } from "@/i18n/config"
import {
  isAppLocale,
  LIGHTWEIGHT_LOCALE_PREF,
  LOCALE_PREFERENCE_PREF,
  persistBootLocalePreference,
  readBootLocalePreference,
  readStoredLocalePreference,
  resolveLocalePreference,
  subscribeSystemLocale,
  type LocalePreference,
} from "@/lib/i18n/locale-preference"
import { getPref, setPref } from "@/lib/tauri/store"
import { useSettingsStore } from "@/stores/settings"

/** Shared by the full shell and least-privilege overlays, including before unlock. */
export function useAppLocaleState(): { locale: Locale; ready: boolean } {
  const language = useSettingsStore((s) => s.settings?.language)
  const languageMode = useSettingsStore((s) => s.settings?.languageMode)
  const loaded = useSettingsStore((s) => s.loaded)
  const refreshSystemLanguage = useSettingsStore((s) => s.refreshSystemLanguage)
  // Match the static export on the initial client render; resolve browser-only
  // preferences immediately after hydration instead of making SSR nondeterministic.
  const [boot, setBoot] = useState<LocalePreference | null>(null)

  useEffect(() => {
    let alive = true
    const update = () => {
      refreshSystemLanguage()
      setBoot(
        (previous) =>
          readStoredLocalePreference() ??
          (previous ? resolveLocalePreference(previous) : readBootLocalePreference())
      )
    }
    update()
    const unsubscribe = subscribeSystemLocale(update)
    if (!readStoredLocalePreference()) {
      void (async () => {
        const saved = await getPref<LocalePreference>(LOCALE_PREFERENCE_PREF)
        const legacy = saved ? null : await getPref<Locale>(LIGHTWEIGHT_LOCALE_PREF)
        if (!alive || useSettingsStore.getState().loaded || readStoredLocalePreference()) return
        const preference =
          saved && (saved.languageMode === "system" || isAppLocale(saved.language))
            ? resolveLocalePreference(saved)
            : isAppLocale(legacy)
              ? resolveLocalePreference({ language: legacy })
              : null
        if (preference) {
          persistBootLocalePreference(preference)
          setBoot(preference)
        }
      })().catch(() => {
        // Native preference failures leave the browser/system fallback usable.
      })
    }
    return () => {
      alive = false
      unsubscribe()
    }
  }, [refreshSystemLanguage])

  useEffect(() => {
    if (!loaded) return
    refreshSystemLanguage()
    const preference = resolveLocalePreference({ language, languageMode })
    persistBootLocalePreference(preference)
    void setPref(LOCALE_PREFERENCE_PREF, preference).catch(() => {})
    void setPref(LIGHTWEIGHT_LOCALE_PREF, preference.language).catch(() => {})
  }, [loaded, language, languageMode, refreshSystemLanguage])

  const locale = !boot
    ? defaultLocale
    : loaded
      ? resolveLocalePreference({ language, languageMode }).language
      : boot.language

  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  return { locale, ready: boot !== null }
}

export function useAppLocale(): Locale {
  return useAppLocaleState().locale
}
