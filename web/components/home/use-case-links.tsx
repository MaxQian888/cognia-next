import { SiteLink } from "@web/components/site-link"
import type { NavMenuItem } from "@web/content/types"
import type { Locale } from "@web/lib/locale"

interface UseCaseLinksProps {
  label: string
  /** The scenario pages, as the navigation's use-case menu names them. */
  items: NavMenuItem[]
  locale: Locale
  docsOrigin?: string
}

/**
 * The way from the signature task into the two scenario pages.
 *
 * The task on the homepage is one loop; the scenario pages carry the same loop
 * through a whole piece of work. They existed with no route into them, so the
 * links sit where a reader who has just watched the loop asks "what would this
 * look like for me". Titles and descriptions are the navigation's own, so the
 * menu and this row cannot describe a page two ways.
 */
export function UseCaseLinks({ label, items, locale, docsOrigin }: UseCaseLinksProps) {
  return (
    <div data-slot="use-case-links">
      <p className="font-mono text-xs uppercase tracking-widest text-muted">{label}</p>
      <ul className="mt-4 grid gap-px border-y border-hairline bg-hairline md:grid-cols-2">
        {items.map((item) => (
          <li key={item.route} className="bg-paper">
            <SiteLink
              target={item}
              locale={locale}
              docsOrigin={docsOrigin}
              className="trace group flex h-full items-start justify-between gap-6 p-6 transition-colors hover:bg-surface md:p-7"
            >
              <span className="flex min-w-0 flex-col gap-1.5">
                <span className="font-medium text-ink">{item.label}</span>
                <span className="text-sm leading-relaxed text-muted">{item.description}</span>
              </span>
              <span
                aria-hidden
                className="mt-0.5 text-ink transition-transform duration-200 group-hover:translate-x-1"
              >
                →
              </span>
            </SiteLink>
          </li>
        ))}
      </ul>
    </div>
  )
}
