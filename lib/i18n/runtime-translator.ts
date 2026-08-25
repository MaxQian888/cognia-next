/**
 * `useTranslations`, for code that is not a component.
 *
 * Working Rule 4 says no hard-coded user-facing strings, and the rule is not
 * really about `.tsx` — it is about what the user reads. Notification titles,
 * toast bodies and run summaries are all user-facing and all emitted from
 * `lib/`, where there is no hook to call. The result today is visible in
 * `lib/scheduler/notification-integration.ts`: English strings in the
 * notification centre for a Chinese user.
 *
 * This is the missing half. It resolves the same locale the UI is showing (the
 * persisted setting, not the OS), loads the same message bundle the
 * `NextIntlClientProvider` uses, and returns a `next-intl` translator over it.
 *
 * Two deliberate properties:
 *
 *  - **It never throws and never returns nothing.** A translator that can fail
 *    turns every caller into a try/catch, and the first caller to skip that
 *    loses a notification over a missing key. An unresolvable key falls back to
 *    the key itself — ugly, and still strictly better than silence.
 *  - **It does not cache across a locale change.** The bundle is memoized per
 *    locale, not globally, so switching language does not leave background
 *    subsystems emitting the old one.
 *
 * Plugin-contributed messages are deliberately NOT merged in. They live behind
 * the plugin registry's React subscription, and a lib-side caller has no
 * lifetime to tie that to; the host bundle is the stable part.
 */

import { createTranslator } from "next-intl"

import { defaultLocale, locales, type Locale } from "@/i18n/config"
import { defaultMessages, loadMessages, type Messages } from "@/i18n/messages"

export type RuntimeTranslator = (key: string, values?: Record<string, unknown>) => string

const bundles = new Map<Locale, Promise<Messages>>()

function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (locales as readonly string[]).includes(value)
}

/** The locale the UI is currently showing, or the default when unreadable. */
export async function currentLocale(): Promise<Locale> {
  try {
    const { useSettingsStore } = await import("@/stores/settings")
    const language = useSettingsStore.getState().settings?.language
    return isLocale(language) ? language : defaultLocale
  } catch {
    return defaultLocale
  }
}

function bundleFor(locale: Locale): Promise<Messages> {
  const cached = bundles.get(locale)
  if (cached) return cached
  // The default bundle is already in the main chunk, so its failure path is
  // unreachable; a code-split locale can fail to load offline, and falling back
  // to the eager bundle is what the UI itself does.
  const loading = loadMessages(locale).catch(() => defaultMessages)
  bundles.set(locale, loading)
  return loading
}

/** Test seam — the per-locale bundle cache would otherwise leak between cases. */
export function __resetRuntimeTranslatorCache(): void {
  bundles.clear()
}

/**
 * A translator scoped to `namespace`, in the locale the UI is showing.
 *
 * @param namespace Dot path into the message bundle, e.g. `"scheduler.notify"`.
 */
export async function getRuntimeTranslator(namespace?: string): Promise<RuntimeTranslator> {
  const locale = await currentLocale()
  const messages = await bundleFor(locale)
  const translate = createTranslator({
    locale,
    messages: messages as Record<string, unknown>,
    ...(namespace ? { namespace } : {}),
    // A missing key must not take the caller's notification down with it.
    onError: () => {},
    getMessageFallback: ({ key }) => (namespace ? `${namespace}.${key}` : key),
  })
  return (key, values) =>
    // `next-intl`'s overloads split on whether values are present; both land in
    // the same runtime call, and the cast keeps the seam one line rather than
    // pushing the branch onto every caller.
    (translate as unknown as RuntimeTranslator)(key, values)
}
