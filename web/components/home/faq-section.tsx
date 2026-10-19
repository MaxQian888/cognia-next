import { Icon } from "@web/components/icon"
import { Reveal } from "@web/components/reveal"
import { Section, SectionHeading } from "@web/components/section"
import { SiteLink } from "@web/components/site-link"
import type { FaqCopy } from "@web/content/types"
import type { Locale } from "@web/lib/locale"

interface FaqSectionProps {
  /** One-based position on the page, rendered as the heading index tag. */
  index?: number
  copy: FaqCopy
  locale: Locale
  docsOrigin?: string
}

/**
 * The questions a reader still has once the argument is made: price,
 * availability, models, data, the agent they already use, the other surfaces.
 *
 * Native `<details>`, so every answer opens without JavaScript and is in the
 * server markup for search and for readers who never hydrate. The heading
 * column holds still on wide screens while the answers scroll past it, which
 * keeps "what is this list" in view for a seven-row index.
 *
 * Each answer is the short version of a fact the repository or the evidence
 * snapshot backs, and links to where the long version lives. The availability
 * answer names where to look rather than the current state, because a static
 * string that says "no release yet" would go stale the day one ships.
 */
export function FaqSection({ copy, locale, docsOrigin, index }: FaqSectionProps) {
  return (
    <Section id="faq" tone="surface" density="tight">
      <div className="grid gap-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16">
        <div className="lg:sticky lg:top-28 lg:self-start">
          <SectionHeading index={index} eyebrow={copy.eyebrow} title={copy.title} />
        </div>

        <Reveal>
          <ul className="border-y border-hairline">
            {copy.items.map((item) => (
              <li key={item.key} className="border-t border-hairline first:border-t-0">
                <details name="faq" className="faq-item group">
                  <summary className="flex cursor-pointer list-none items-start justify-between gap-6 py-6 text-left text-lg font-medium leading-snug text-ink transition-colors hover:text-muted focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-action">
                    <span>{item.question}</span>
                    <Icon
                      name="chevronDown"
                      size={16}
                      className="mt-1 shrink-0 text-muted transition-transform duration-200 group-open:rotate-180"
                    />
                  </summary>
                  <div className="pb-7 pr-10">
                    <p className="max-w-2xl leading-relaxed text-muted">{item.answer}</p>
                    {item.link ? (
                      <SiteLink
                        target={item.link}
                        locale={locale}
                        docsOrigin={docsOrigin}
                        className="mt-4 inline-flex items-center gap-1 font-mono text-xs text-ink underline decoration-hairline-strong underline-offset-4 transition-colors hover:decoration-ink"
                      />
                    ) : null}
                  </div>
                </details>
              </li>
            ))}
          </ul>
        </Reveal>
      </div>
    </Section>
  )
}
