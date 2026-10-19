import { InventoryFigures } from "@web/components/inventory-figures"
import { Reveal } from "@web/components/reveal"
import { Section, SectionHeading } from "@web/components/section"
import { SiteLink } from "@web/components/site-link"
import { format } from "@web/content"
import type { CommonCopy, InventoryCopy, TrustCopy } from "@web/content/types"
import { type Evidence, formatDate, freshness, latestRelease } from "@web/lib/evidence"
import type { Locale } from "@web/lib/locale"

interface TrustSectionProps {
  /** One-based position on the page, rendered as the heading index tag. */
  index?: number
  copy: TrustCopy
  common: CommonCopy
  /** Labels for the figures counted from the checkout at build time. */
  inventoryCopy: InventoryCopy
  evidence: Evidence
  locale: Locale
  docsOrigin?: string
}

/**
 * Cell padding shared by the cards and both figure bands, so their text starts
 * on the same line in every column.
 */
const CELL = "px-5 py-6 md:px-6"

/**
 * "Built in the open. Controlled in use." (spec §4.7)
 *
 * Three bands on one set of four columns: the claims (Source, Data,
 * Permission, Record), the figures read from GitHub, and the figures counted
 * from the checkout. Sharing the column lines is what lets the eye read a
 * claim and the figures under it as one body of evidence; three grids of two,
 * four and seven columns read as three unrelated strips. The provenance rail
 * that used to sit beside the claims retold the signature task's steps, which
 * the task section already shows, and was removed.
 *
 * Every figure is read from the build-time evidence snapshot and carries the
 * time it was read, or counted from the checkout at build time. Nothing here
 * is hand-maintained, and a figure that could not be refreshed says so rather
 * than quietly ageing behind a fresh-looking label. Figures render at their
 * value: a count that ticks up can be read, or captured, halfway, and a
 * halfway figure is a wrong one.
 */
export function TrustSection({
  copy,
  common,
  inventoryCopy,
  evidence,
  locale,
  docsOrigin,
  index,
}: TrustSectionProps) {
  const state = freshness(evidence)
  const release = latestRelease(evidence)
  const numbers = new Intl.NumberFormat(locale === "zh" ? "zh-CN" : "en-US")
  const count = (value: number | null) => (value === null ? "—" : numbers.format(value))

  const stats: Array<{ label: string; value: string }> = [
    { label: copy.starsLabel, value: count(evidence.repo.stars) },
    { label: copy.contributorsLabel, value: count(evidence.contributors) },
    { label: copy.licenseLabel, value: evidence.repo.license ?? "—" },
    { label: copy.releasesLabel, value: release?.tagName ?? copy.noReleasesYet },
  ]

  return (
    <Section id="trust" tone="paper" density="tight">
      <SectionHeading
        index={index}
        eyebrow={copy.eyebrow}
        title={copy.title}
        subtitle={copy.subtitle}
      />

      <Reveal className="mt-14">
        <ul
          aria-label={copy.title}
          data-slot="trust-cards"
          className="grid gap-px border-y border-hairline bg-hairline sm:grid-cols-2 lg:grid-cols-4"
        >
          {copy.cards.map((card) => (
            <li key={card.key} className={`flex flex-col bg-surface ${CELL}`}>
              <p className="font-mono text-xs uppercase tracking-widest text-muted">{card.label}</p>
              <p className="mt-4 flex-1 text-sm leading-relaxed text-ink">{card.body}</p>
              <SiteLink
                target={{ label: card.linkLabel, href: card.href, route: card.route }}
                locale={locale}
                docsOrigin={docsOrigin}
                className="mt-6 inline-block font-mono text-xs text-ink underline decoration-hairline-strong underline-offset-4"
              />
            </li>
          ))}
        </ul>
      </Reveal>

      <div className="mt-16">
        <p className="font-mono text-xs uppercase tracking-widest text-muted">{copy.statsLabel}</p>
        {/* One strip, not four floating figures: the numbers are read from the
         * same snapshot at the same moment, and sharing hairlines says so. */}
        <dl
          data-slot="trust-stats"
          className="mt-4 grid grid-cols-2 gap-px border-y border-hairline bg-hairline lg:grid-cols-4"
        >
          {stats.map((stat) => (
            <div key={stat.label} className={`trace bg-paper ${CELL}`}>
              <dt className="font-mono text-xs uppercase tracking-widest text-muted">
                {stat.label}
              </dt>
              <dd className="mt-3 text-3xl font-medium tabular-nums tracking-tight text-ink">
                {stat.value}
              </dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 font-mono text-xs text-muted">
          {format(state.stale ? common.stale : common.asOf, { date: formatDate(state.date) })}
        </p>
      </div>

      {/* Counted from the checkout, not read from GitHub: the second kind of
       * figure a reader can reproduce, so it sits with the first, on the same
       * column lines. */}
      <InventoryFigures
        className="mt-14"
        copy={inventoryCopy}
        inventory={evidence.inventory}
        locale={locale}
        cellClassName={CELL}
      />
    </Section>
  )
}
