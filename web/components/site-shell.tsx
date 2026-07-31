import type { ReactNode } from "react"
import evidenceData from "@web/content/generated/evidence.json"
import { getCopy } from "@web/content"
import { type Evidence, releaseState } from "@web/lib/evidence"
import type { Locale } from "@web/lib/locale"
import { RELEASES_URL, docsUrl } from "@web/lib/site"
import { PointerCompanion } from "./pointer-companion"
import { SiteFooter } from "./site-footer"
import { SiteNav } from "./site-nav"

interface SiteShellProps {
  locale: Locale
  /** Unprefixed route of the current page, for the language switcher. */
  route: string
  children: ReactNode
}

/** The build-time evidence snapshot, shared by every page. */
export const evidence = evidenceData as Evidence

/**
 * Navigation, main landmark and footer around every page.
 *
 * The release state is resolved once here and passed down, so the download
 * wording in the navigation, the hero and the final call to action can never
 * disagree with each other.
 */
export function SiteShell({ locale, route, children }: SiteShellProps) {
  const copy = getCopy(locale)
  const state = releaseState(evidence, RELEASES_URL)
  const docsOrigin = docsUrl()

  return (
    <>
      <SiteNav
        locale={locale}
        route={route}
        copy={copy}
        releaseState={state}
        docsOrigin={docsOrigin}
      />
      <main id="main">{children}</main>
      <SiteFooter locale={locale} copy={copy} docsOrigin={docsOrigin} />
      {/* Mounted once, at the shell, so every page gets it and no page can
       * mount two. Renders nothing on a coarse pointer or under reduced
       * motion — see `pointer-companion.tsx`. */}
      <PointerCompanion />
    </>
  )
}
