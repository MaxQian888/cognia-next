import "../global.css"
import type { ReactNode } from "react"
import { notFound } from "next/navigation"
import { Provider } from "@/components/provider"
import { i18n } from "@/lib/i18n"

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
        <Provider lang={lang}>{children}</Provider>
      </body>
    </html>
  )
}
