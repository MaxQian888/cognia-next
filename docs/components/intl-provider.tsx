"use client"

import type { ComponentProps, ReactNode } from "react"
import { NextIntlClientProvider } from "next-intl"

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
    <NextIntlClientProvider locale={locale} messages={messages}>
      {children}
    </NextIntlClientProvider>
  )
}
