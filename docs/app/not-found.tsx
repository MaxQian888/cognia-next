import "./global.css"
import { ThemeProvider } from "next-themes"

import { NotFoundContent } from "@/components/not-found-content"
import { i18n } from "@/lib/i18n"
import enMessages from "../../i18n/messages/en.json"
import zhMessages from "../../i18n/messages/zh-CN.json"

/**
 * The site's only 404 surface. A static export can't route unknown paths, so
 * Cloudflare Pages serves this single pre-rendered `out/404.html` for every
 * miss — it therefore lives outside `[lang]` and recovers the locale from the
 * URL at runtime.
 *
 * It also sits outside the `[lang]` root layout, so it has to import the
 * stylesheet and mount the theme provider itself; fumadocs' dark mode is
 * class-based and would otherwise never apply here.
 */
export default function NotFound() {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <NotFoundContent
        languages={i18n.languages}
        defaultLanguage={i18n.defaultLanguage}
        messages={{
          en: { docsSite: enMessages.docsSite },
          zh: { docsSite: zhMessages.docsSite },
        }}
      />
    </ThemeProvider>
  )
}
