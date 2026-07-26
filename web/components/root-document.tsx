import { GeistMono } from "geist/font/mono"
import { GeistSans } from "geist/font/sans"
import type { ReactNode } from "react"
import { ThemeProvider } from "@web/components/theme-provider"
import { HTML_LANG, type Locale } from "@web/lib/locale"

/**
 * The document shell.
 *
 * The site has two root layouts — one per locale — so `<html lang>` is a real
 * static attribute rather than something patched in after hydration. Both share
 * this component so the font variables, the theme provider and the base classes
 * cannot drift apart between locales.
 *
 * `suppressHydrationWarning` is required on `<html>`: `next-themes` writes the
 * theme class before React hydrates, which is exactly the mismatch that
 * warning is for.
 */
export function RootDocument({ locale, children }: { locale: Locale; children: ReactNode }) {
  return (
    <html lang={HTML_LANG[locale]} suppressHydrationWarning>
      <body className={`${GeistSans.variable} ${GeistMono.variable} font-sans antialiased`}>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  )
}
