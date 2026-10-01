"use client"

import { createContext, useContext, useEffect, useMemo, useState } from "react"
import {
  NextIntlClientProvider,
  useLocale,
  useTimeZone,
  useTranslations,
  type AbstractIntlMessages,
} from "next-intl"
import { loadMessages, type Messages } from "@/i18n/messages"
import type { Locale } from "@/i18n/config"
import { PageLoading } from "@/components/ui/loading-states"
import { Button } from "@/components/ui/button"

export const LocaleReadyContext = createContext(true)

/** Mount only where the complete UI is allowed to start, after account entry.
 * Settings hydration and native window/splash handoff must remain outside.
 * Overlay callers can use this without importing the plugin/account runtime.
 */
export function FullMessagesGate({
  children,
  additionalMessages,
  ready = true,
}: {
  children: React.ReactNode
  additionalMessages?: Partial<Record<Locale, AbstractIntlMessages>>
  ready?: boolean
}) {
  const localeReady = useContext(LocaleReadyContext)
  const locale = useLocale() as Locale
  const timeZone = useTimeZone()
  const t = useTranslations("loading")
  const [bundle, setBundle] = useState<{ locale: Locale; messages: Messages } | null>(null)
  const [failure, setFailure] = useState<Locale | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!localeReady || !ready) return
    let active = true
    void loadMessages(locale).then(
      (messages) => {
        if (active) {
          setBundle({ locale, messages })
          setFailure(null)
        }
      },
      () => {
        if (active) setFailure(locale)
      }
    )
    return () => {
      active = false
    }
  }, [locale, attempt, localeReady, ready])

  const messages = useMemo(
    () => (bundle ? { ...bundle.messages, ...additionalMessages?.[bundle.locale] } : undefined),
    [bundle, additionalMessages]
  )

  // Keep an already mounted workspace alive while switching languages. The
  // provider changes locale and messages together only after the chunk arrives.
  return (
    <>
      {failure === locale && (
        <div role="alert" className="flex items-center justify-center gap-3 p-4">
          <span>{t("languageLoadFailed")}</span>
          <Button
            variant="outline"
            onClick={() => {
              setFailure(null)
              setAttempt((value) => value + 1)
            }}
          >
            {t("retryLanguage")}
          </Button>
        </div>
      )}
      {bundle ? (
        <NextIntlClientProvider locale={bundle.locale} messages={messages} timeZone={timeZone}>
          {children}
        </NextIntlClientProvider>
      ) : failure === locale ? null : (
        <PageLoading variant="workspace" milestone="interface" allowReload />
      )}
    </>
  )
}
