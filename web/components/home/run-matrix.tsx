import { Icon, type IconName } from "@web/components/icon"
import { Reveal } from "@web/components/reveal"
import { Section, SectionHeading } from "@web/components/section"
import { SiteLink } from "@web/components/site-link"
import type { RunCopy } from "@web/content/types"
import type { Locale } from "@web/lib/locale"

/**
 * One mark per strategy, keyed by the strategy id the copy already carries.
 * Presentation, not content, so it lives here rather than in `SiteCopy`.
 */
const STRATEGY_ICON: Record<string, IconName> = {
  local: "laptop",
  byok: "approval",
  subscription: "model",
  fallback: "workflow",
}

interface RunMatrixProps {
  /** One-based position on the page, rendered as the heading index tag. */
  index?: number
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
export function RunMatrix({ copy, learnMore, locale, docsOrigin, index }: RunMatrixProps) {
  const headings = [
    copy.headings.leaves,
    copy.headings.receives,
    copy.headings.tools,
    copy.headings.approval,
  ]

  return (
    <Section id="run" tone="paper">
      <SectionHeading
        index={index}
        eyebrow={copy.eyebrow}
        title={copy.title}
        subtitle={copy.subtitle}
      />

      {/* Desktop: one table, drawn as a matrix of bounded cells rather than
       * ruled prose. Every cell has its own boundary, so the eye reads across a
       * row and down a column equally, which is what a boundary comparison is
       * for. Still a real `<table>`: the row and column relationships have to
       * survive a screen reader. */}
      <Reveal className="mt-14 hidden lg:block">
        <div className="overflow-x-auto">
          <table className="w-full border-separate border-spacing-px bg-hairline text-left [border:1px_solid_var(--hairline)]">
            <thead>
              <tr>
                <th
                  scope="col"
                  className="bg-surface px-5 py-3.5 font-mono text-xs uppercase tracking-widest text-muted"
                >
                  {copy.headings.strategy}
                </th>
                {headings.map((heading) => (
                  <th
                    key={heading}
                    scope="col"
                    className="bg-surface px-5 py-3.5 font-mono text-xs uppercase tracking-widest text-muted"
                  >
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {copy.strategies.map((strategy) => (
                <tr key={strategy.key} className="group align-top">
                  <th
                    scope="row"
                    className="bg-paper px-5 py-6 font-medium text-ink transition-colors group-hover:bg-surface"
                  >
                    <span className="flex items-center gap-2.5">
                      {STRATEGY_ICON[strategy.key] ? (
                        <Icon name={STRATEGY_ICON[strategy.key]} size={16} className="text-muted" />
                      ) : null}
                      {strategy.name}
                    </span>
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
                  {[strategy.leaves, strategy.receives, strategy.tools, strategy.approval].map(
                    (answer, index) => (
                      <td
                        key={index}
                        className="bg-paper px-5 py-6 text-sm leading-relaxed text-ink transition-colors group-hover:bg-surface"
                      >
                        {answer}
                      </td>
                    )
                  )}
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
