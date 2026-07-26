import type { SiteCopy } from "@web/content/types"
import type { Locale } from "@web/lib/locale"
import { LICENSE_URL, LICENSE_SPDX } from "@web/lib/site"
import { SiteLink } from "./site-link"

interface SiteFooterProps {
  locale: Locale
  copy: SiteCopy
  docsOrigin?: string
}

/**
 * The footer is a verifiable index (spec §4.8): every entry resolves to
 * something that exists. Roadmap, Status and Community are deliberately absent
 * — the spec forbids shipping a link to a surface that is not public, and an
 * empty link is worse than a missing one.
 *
 * Columns are `<details>` so they collapse on mobile without JavaScript; from
 * `md` up CSS holds them open and disables the summary control.
 */
export function SiteFooter({ locale, copy, docsOrigin }: SiteFooterProps) {
  return (
    <footer className="border-t border-hairline bg-surface">
      <div className="mx-auto max-w-shell px-5 py-16 lg:px-8">
        <div className="grid gap-2 md:grid-cols-3 md:gap-10">
          {copy.footer.columns.map((column) => (
            <details
              key={column.title}
              className="footer-accordion border-b border-hairline md:border-0"
            >
              <summary className="cursor-pointer list-none py-4 font-mono text-xs uppercase tracking-widest text-muted md:cursor-default md:py-0">
                {column.title}
              </summary>
              <div className="footer-accordion-panel pb-4 md:pb-0 md:pt-4">
                <ul className="flex flex-col gap-2.5">
                  {column.links.map((link) => (
                    <li key={link.label}>
                      <SiteLink
                        target={link}
                        locale={locale}
                        docsOrigin={docsOrigin}
                        className="text-sm text-ink transition-colors hover:text-muted"
                      />
                    </li>
                  ))}
                </ul>
              </div>
            </details>
          ))}
        </div>

        <div className="mt-14 flex flex-col gap-3 border-t border-hairline pt-6 md:flex-row md:items-center md:justify-between">
          <p className="text-sm text-muted">{copy.footer.colophon}</p>
          <p className="font-mono text-xs text-muted">
            {copy.footer.licenseLabel}{" "}
            <a
              href={LICENSE_URL}
              target="_blank"
              rel="noreferrer"
              className="text-ink underline decoration-hairline-strong underline-offset-4"
            >
              {LICENSE_SPDX}
            </a>
          </p>
        </div>
      </div>
    </footer>
  )
}
