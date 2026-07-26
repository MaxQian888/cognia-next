import { Reveal } from "@web/components/reveal"
import { Section, SectionHeading } from "@web/components/section"
import { SiteLink } from "@web/components/site-link"
import type { RunCopy } from "@web/content/types"
import type { Locale } from "@web/lib/locale"

interface RunMatrixProps {
  copy: RunCopy
  learnMore: string
  locale: Locale
  docsOrigin?: string
}

/**
 * "Choose the model. See the boundary." (spec §4.5)
 *
 * A run-strategy matrix rather than a wall of provider logos: a logo says a
 * name, and the question a reader actually has is what leaves their machine.
 * Every row answers the four questions the spec requires — what leaves, who
 * receives, which tools, what needs confirmation — and links to versioned
 * documentation rather than restating it here.
 *
 * Rendered as a real table so the row/column relationships survive a screen
 * reader; on narrow viewports the same data becomes stacked definition blocks.
 */
export function RunMatrix({ copy, learnMore, locale, docsOrigin }: RunMatrixProps) {
  const headings = [
    copy.headings.leaves,
    copy.headings.receives,
    copy.headings.tools,
    copy.headings.approval,
  ]

  return (
    <Section tone="paper">
      <SectionHeading title={copy.title} subtitle={copy.subtitle} />

      {/* Desktop: one table. */}
      <Reveal className="mt-14 hidden lg:block">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-hairline-strong">
                <th
                  scope="col"
                  className="py-3 pr-6 font-mono text-xs uppercase tracking-widest text-muted"
                >
                  {copy.headings.strategy}
                </th>
                {headings.map((heading) => (
                  <th
                    key={heading}
                    scope="col"
                    className="py-3 pr-6 font-mono text-xs uppercase tracking-widest text-muted"
                  >
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {copy.strategies.map((strategy) => (
                <tr key={strategy.key} className="border-b border-hairline align-top">
                  <th scope="row" className="py-6 pr-6 font-medium text-ink">
                    {strategy.name}
                    <span className="mt-2 block max-w-56 text-sm font-normal leading-relaxed text-muted">
                      {strategy.summary}
                    </span>
                    <SiteLink
                      target={{ label: learnMore, docsPath: strategy.docsPath }}
                      locale={locale}
                      docsOrigin={docsOrigin}
                      className="mt-3 inline-block font-mono text-xs text-ink underline decoration-hairline-strong underline-offset-4"
                    />
                  </th>
                  <td className="py-6 pr-6 text-sm leading-relaxed text-muted">
                    {strategy.leaves}
                  </td>
                  <td className="py-6 pr-6 text-sm leading-relaxed text-muted">
                    {strategy.receives}
                  </td>
                  <td className="py-6 pr-6 text-sm leading-relaxed text-muted">{strategy.tools}</td>
                  <td className="py-6 text-sm leading-relaxed text-muted">{strategy.approval}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Reveal>

      {/* Narrow: the same rows, stacked, with the column names kept as labels. */}
      <Reveal className="mt-12 lg:hidden">
        <div className="flex flex-col gap-px bg-hairline">
          {copy.strategies.map((strategy) => (
            <div key={strategy.key} className="bg-paper py-6">
              <p className="font-medium text-ink">{strategy.name}</p>
              <p className="mt-2 text-sm leading-relaxed text-muted">{strategy.summary}</p>
              <dl className="mt-5 flex flex-col gap-3">
                {[
                  [copy.headings.leaves, strategy.leaves],
                  [copy.headings.receives, strategy.receives],
                  [copy.headings.tools, strategy.tools],
                  [copy.headings.approval, strategy.approval],
                ].map(([term, value]) => (
                  <div key={term}>
                    <dt className="font-mono text-xs uppercase tracking-widest text-muted">
                      {term}
                    </dt>
                    <dd className="mt-1 text-sm leading-relaxed text-ink">{value}</dd>
                  </div>
                ))}
              </dl>
              <SiteLink
                target={{ label: learnMore, docsPath: strategy.docsPath }}
                locale={locale}
                docsOrigin={docsOrigin}
                className="mt-4 inline-block font-mono text-xs text-ink underline decoration-hairline-strong underline-offset-4"
              />
            </div>
          ))}
        </div>
      </Reveal>

      <p className="mt-10 max-w-2xl border-l-2 border-hairline-strong pl-4 text-sm leading-relaxed text-muted">
        {copy.note}
      </p>
    </Section>
  )
}
