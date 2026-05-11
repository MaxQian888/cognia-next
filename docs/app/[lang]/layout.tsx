import "../global.css"
import type { ReactNode } from "react"
import { notFound } from "next/navigation"
import { RootProvider } from "fumadocs-ui/provider/next"
import { i18n } from "@/lib/i18n"
import { i18nUI } from "@/lib/layout.shared"

export function generateStaticParams() {
  return i18n.languages.map((lang) => ({ lang }))
}

export default async function RootLayout({
  params,
  children,
}: {
  params: Promise<{ lang: string }>
  children: ReactNode
}) {
  const { lang } = await params
  if (!(i18n.languages as readonly string[]).includes(lang)) notFound()

  return (
    <html lang={lang} suppressHydrationWarning>
      <body>
        <RootProvider i18n={i18nUI.provider(lang)}>{children}</RootProvider>
      </body>
    </html>
  )
}
