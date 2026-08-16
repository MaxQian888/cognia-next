"use client"

import type { ComponentProps, ReactNode } from "react"
import { NextIntlClientProvider } from "next-intl"

// Relative rather than `@/`: the repo's Jest runner maps that alias to the app
// root, not to `docs/`, and this component has tests.
import { DOCS_TIME_ZONE } from "../lib/time-zone"

type Messages = NonNullable<ComponentProps<typeof NextIntlClientProvider>["messages"]>

export function IntlProvider({
  locale,
  messages,
  children,
}: {
  locale: string
  messages: Messages
  children: ReactNode
}) {
  return (
    <NextIntlClientProvider
      locale={locale}
      messages={messages}
      // The docs site is a static export; pinning the time zone keeps
      // prerendered markup independent of the build machine. See
      // `lib/time-zone.ts`.
      timeZone={DOCS_TIME_ZONE}
    >
      {children}
    </NextIntlClientProvider>
  )
}
