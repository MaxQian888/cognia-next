import { defaultLocale, type Locale } from "@/i18n/config"

export const BOOT_LOCALE_STORAGE_KEY = "cognia.locale-preference"
export const LIGHTWEIGHT_LOCALE_PREF = "appearance.locale"
export const LOCALE_PREFERENCE_PREF = "appearance.localePreference"

type LocaleSettings = { language?: unknown; languageMode?: unknown }
export type LocalePreference = { language: Locale; languageMode: "system" | "manual" }

export function isAppLocale(value: unknown): value is Locale {
  return value === "en" || value === "zh-CN"
}

/** Pick the first supported language; the available Chinese pack is simplified. */
export function resolveSystemLocale(languages?: readonly string[]): Locale {
  const preferred =
    languages ??
    (typeof navigator === "undefined"
      ? []
      : navigator.languages?.length
        ? navigator.languages
        : [navigator.language])
  for (const tag of preferred) {
    const language = tag.toLowerCase().split(/[-_]/)[0]
    if (language === "zh") return "zh-CN"
    if (language === "en") return "en"
  }
  return defaultLocale
}

export function resolveLocalePreference(settings?: LocaleSettings | null): LocalePreference {
  // A legacy concrete locale represents an existing choice. Only new settings
  // or an explicit system mode should start following the operating system.
  if (settings?.languageMode !== "system" && isAppLocale(settings?.language)) {
    return { language: settings.language, languageMode: "manual" }
  }
  return { language: resolveSystemLocale(), languageMode: "system" }
}

export function readStoredLocalePreference(): LocalePreference | null {
  try {
    const raw = localStorage.getItem(BOOT_LOCALE_STORAGE_KEY)
    if (!raw) return null
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== "object") return null
    const preference = value as LocaleSettings
    if (preference.languageMode !== "system" && !isAppLocale(preference.language)) return null
    return resolveLocalePreference(preference)
  } catch {
    return null
  }
}

export function readBootLocalePreference(): LocalePreference {
  return readStoredLocalePreference() ?? resolveLocalePreference()
}

/** Account-independent boot hint: never copy any other settings into localStorage. */
export function persistBootLocalePreference(settings: LocaleSettings): void {
  try {
    localStorage.setItem(BOOT_LOCALE_STORAGE_KEY, JSON.stringify(resolveLocalePreference(settings)))
  } catch {
    // Private browsing and exhausted storage must not block language selection.
  }
}

export function subscribeSystemLocale(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {}
  const onVisible = () => {
    if (document.visibilityState === "visible") listener()
  }
  window.addEventListener("languagechange", listener)
  document.addEventListener("visibilitychange", onVisible)
  return () => {
    window.removeEventListener("languagechange", listener)
    document.removeEventListener("visibilitychange", onVisible)
  }
}
