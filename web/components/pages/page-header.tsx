import type { ReactNode } from "react"
import { Hairline } from "@web/components/hairline"
import { Reveal } from "@web/components/reveal"
import { SiteLink } from "@web/components/site-link"
import type {
  CapabilitySection,
  CommonCopy,
  PageHeader as PageHeaderCopy,
} from "@web/content/types"
import type { Locale } from "@web/lib/locale"

interface PageHeaderProps {
  copy: PageHeaderCopy
  common: CommonCopy
  locale: Locale
  /**
   * Sections to list in the in-page index. Only sections carrying an `id` can
   * be linked, so ones without are skipped rather than rendered as dead text.
   */
  sections?: CapabilitySection[]
  /** Page-specific detail for the right column, when there is no index. */
  meta?: ReactNode
  docsOrigin?: string
}

/**
 * The opening block of every sub-page. Carries the page's only `h1`, so a
 * reader arriving from search lands on a heading that names the page rather
 * than on the first section's heading.
 *
 * Two columns from `lg`. The single-column version left roughly half of a
 * 1480px shell empty on all eight sub-pages, and the right column is the place
 * to answer "what is on this page" — which, on pages that run to four or five
 * anchored sections, the reader otherwise has to discover by scrolling.
 *
 * `Reveal` with a `mount` trigger, not `view`: this block is the first screen,
 * and an in-view trigger would hold the page's `h1` at `opacity: 0` for a
 * reader who never scrolls.
 */
export function PageHeader({ copy, common, locale, sections, meta, docsOrigin }: PageHeaderProps) {
  const anchored = (sections ?? []).filter((section) => section.id)

  return (
    <div className="bg-paper">
      <div className="mx-auto max-w-shell px-5 pb-16 pt-20 md:pt-28 lg:px-8">
        <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)] lg:gap-16">
          <Reveal trigger="mount">
            {/* A single link home, not a `<nav>`: one link is not a navigation
             * region, and adding a second landmark would clutter the landmark
             * list every page already gets from the site header and footer. */}
            <p className="font-mono text-xs text-muted">
              <SiteLink
                target={{ label: common.breadcrumbHome, route: "/" }}
                locale={locale}
                docsOrigin={docsOrigin}
                className="transition-colors hover:text-ink"
              />
              <span aria-hidden className="px-2">
                /
              </span>
              <span className="text-ink">{copy.eyebrow}</span>
            </p>

            <h1 className="mt-6 max-w-3xl text-balance text-4xl font-medium leading-[1.1] tracking-tight text-ink md:text-5xl lg:text-6xl">
              {copy.title}
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-relaxed text-muted">{copy.subtitle}</p>
          </Reveal>

          {anchored.length > 0 || meta ? (
            <div className="mt-12 border-t border-hairline pt-8 lg:mt-0 lg:border-l lg:border-t-0 lg:pl-10 lg:pt-2">
              {anchored.length > 0 ? (
                <>
                  <p className="font-mono text-xs uppercase tracking-widest text-muted">
                    {common.onThisPage}
                  </p>
                  <ul className="mt-5 flex flex-col gap-px bg-hairline">
                    {anchored.map((section, index) => (
                      <li key={section.id} className="bg-paper">
                        <a
                          href={`#${section.id}`}
                          className="trace flex items-baseline gap-3 py-3 text-sm text-ink transition-colors hover:text-muted"
                        >
                          <span aria-hidden className="font-mono text-[10px] text-muted">
                            {String(index + 1).padStart(2, "0")}
                          </span>
                          {section.title}
                        </a>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
              {meta ? <div className={anchored.length > 0 ? "mt-8" : ""}>{meta}</div> : null}
            </div>
          ) : null}
        </div>
      </div>

      <Hairline className="mx-auto max-w-shell" />
    </div>
  )
}
