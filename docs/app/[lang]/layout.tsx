import "../global.css"
import type { Metadata } from "next"
import type { ReactNode } from "react"
import { notFound } from "next/navigation"
import { IntlProvider } from "@/components/intl-provider"
import { Provider } from "@/components/provider"
import { i18n } from "@/lib/i18n"
import { SITE_NAME, siteUrl } from "@/lib/site"
import enMessages from "../../../i18n/messages/en.json"
import zhMessages from "../../../i18n/messages/zh-CN.json"

// `metadataBase` is what lets every page emit absolute canonical/OG URLs; a
// static export has no request origin to infer one from at runtime.
export const metadata: Metadata = {
  metadataBase: new URL(siteUrl()),
  title: { template: `%s — ${SITE_NAME}`, default: SITE_NAME },
}

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
  const messages = {
    docsSite: lang === "en" ? enMessages.docsSite : zhMessages.docsSite,
  }

  return (
    <html lang={lang} suppressHydrationWarning>
      <body>
        <IntlProvider locale={lang === "zh" ? "zh-CN" : "en"} messages={messages}>
          <Provider lang={lang}>{children}</Provider>
        </IntlProvider>
      </body>
    </html>
  )
}
