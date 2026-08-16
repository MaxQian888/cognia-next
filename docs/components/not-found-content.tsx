"use client"

import { useSyncExternalStore, type ComponentProps } from "react"
import { NextIntlClientProvider, useTranslations } from "next-intl"

// Relative rather than `@/`: the repo's Jest runner maps that alias to the
// app root, not to `docs/`, and this component has tests.
import { localeFromPathname } from "../lib/locale-path"
import { DOCS_TIME_ZONE } from "../lib/time-zone"

type Locale = "en" | "zh"
const subscribeToPathname = () => () => {}

function isLocale(value: string): value is Locale {
  return value === "en" || value === "zh"
}

type Props = {
  /** From `lib/i18n`, injected by the server component — importing fumadocs' i18n here would pull an ESM-only module into the Jest graph. */
  languages: readonly string[]
  defaultLanguage: string
  messages: Record<Locale, NonNullable<ComponentProps<typeof NextIntlClientProvider>["messages"]>>
}

/**
 * The 404 body, rendered client-side because the locale comes from the URL
 * rather than route params — see `lib/locale-path.ts`.
 *
 * The server snapshot uses the default locale so the pre-rendered `out/404.html`
 * is never blank; React reconciles it with the browser pathname after hydration.
 */
export function NotFoundContent({ languages, defaultLanguage, messages }: Props) {
  const defaultLocale: Locale = isLocale(defaultLanguage) ? defaultLanguage : "en"
  const locale = useSyncExternalStore(
    subscribeToPathname,
    () => {
      const detected = localeFromPathname(window.location.pathname, languages, defaultLanguage)
      return isLocale(detected) ? detected : defaultLocale
    },
    () => defaultLocale
  )

  return (
    <NextIntlClientProvider
      locale={locale === "zh" ? "zh-CN" : "en"}
      messages={messages[locale]}
      // `out/404.html` is prerendered like every other page — this provider
      // needs the same global default as `intl-provider.tsx`.
      timeZone={DOCS_TIME_ZONE}
    >
      <NotFoundBody locale={locale} />
    </NextIntlClientProvider>
  )
}

function NotFoundBody({ locale }: { locale: Locale }) {
  const t = useTranslations("docsSite.notFound")
  const otherLocale: Locale = locale === "en" ? "zh" : "en"

  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col items-center justify-center gap-6 px-6 text-center">
      <p className="text-7xl font-semibold tracking-tight text-fd-muted-foreground/40">404</p>

      <div className="space-y-2">
        <h1 className="text-2xl font-semibold text-fd-foreground">{t("heading")}</h1>
        <p className="text-fd-muted-foreground">{t("body")}</p>
      </div>

      <div className="flex flex-wrap items-center justify-center gap-3">
        <a
          href={`/${locale}/docs`}
          className="rounded-md bg-fd-primary px-4 py-2 text-sm font-medium text-fd-primary-foreground transition-opacity hover:opacity-90"
        >
          {t("docs")}
        </a>
        <a
          href={`/${otherLocale}/docs`}
          className="rounded-md border border-fd-border px-4 py-2 text-sm transition-colors hover:bg-fd-accent hover:text-fd-accent-foreground"
        >
          {t("other")}
        </a>
      </div>
    </main>
  )
}
