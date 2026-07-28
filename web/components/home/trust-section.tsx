import { CountUp } from "@web/components/count-up"
import { Reveal } from "@web/components/reveal"
import { Section, SectionHeading } from "@web/components/section"
import { SiteLink } from "@web/components/site-link"
import { format } from "@web/content"
import type { CommonCopy, TrustCopy } from "@web/content/types"
import { type Evidence, formatDate, freshness, latestRelease } from "@web/lib/evidence"
import type { Locale } from "@web/lib/locale"

interface TrustSectionProps {
  copy: TrustCopy
  common: CommonCopy
  evidence: Evidence
  locale: Locale
  docsOrigin?: string
}

/**
 * "Built in the open. Controlled in use." (spec §4.7)
 *
 * A 2×2 gapless bento — Source, Data, Permission, Record — plus the page's one
 * second-read moment: the provenance rail threading Source → Action →
 * Permission → Result down a narrow sidebar. It appears exactly once on the
 * site, which is what makes it worth noticing.
 *
 * Every figure is read from the build-time evidence snapshot and carries the
 * time it was read. Nothing here is hand-maintained, and a figure that could
 * not be refreshed says so rather than quietly ageing behind a fresh-looking
 * label.
 */
export function TrustSection({ copy, common, evidence, locale, docsOrigin }: TrustSectionProps) {
  const state = freshness(evidence)
  const release = latestRelease(evidence)

  // `string | number` on purpose: `CountUp` counts a number and renders a
  // string verbatim, so "52" ticks while "AGPL-3.0-or-later" and "—" do not.
  const stats: Array<{ label: string; value: string | number }> = [
    {
      label: copy.starsLabel,
      value: evidence.repo.stars === null ? "—" : evidence.repo.stars,
    },
    {
      label: copy.contributorsLabel,
      value: evidence.contributors === null ? "—" : evidence.contributors,
    },
    { label: copy.licenseLabel, value: evidence.repo.license ?? "—" },
    { label: copy.releasesLabel, value: release?.tagName ?? copy.noReleasesYet },
  ]

  return (
    <Section id="trust" tone="paper">
      <SectionHeading eyebrow={copy.eyebrow} title={copy.title} subtitle={copy.subtitle} />

      <Reveal className="mt-14">
        <div className="grid gap-14 lg:grid-cols-[minmax(0,1fr)_minmax(0,14rem)] lg:gap-16">
          <div className="overflow-hidden rounded-stage border border-hairline">
            {/* A list, not four divs: "Source" also names a step on the
             * provenance rail beside it, and the two need to be distinguishable
             * to a screen reader as well as to an eye. */}
            <ul aria-label={copy.title} className="grid gap-px bg-hairline sm:grid-cols-2">
              {copy.cards.map((card) => (
                <li key={card.key} className="flex flex-col bg-surface p-6 md:p-8">
                  <p className="font-mono text-xs uppercase tracking-widest text-muted">
                    {card.label}
                  </p>
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
          </div>

          {/* The site's single second-read moment (spec §2.4). */}
          <aside aria-label={copy.provenanceLabel} className="lg:pt-2">
            <p className="font-mono text-xs uppercase tracking-widest text-muted">
              {copy.provenanceLabel}
            </p>
            <ol className="mt-6 flex flex-col">
              {copy.provenance.map((step, index) => (
                <li
                  key={step.label}
                  className={`relative border-l border-hairline-strong py-4 pl-5 ${
                    index === 0 ? "pt-0" : ""
                  }`}
                >
                  <span
                    aria-hidden
                    className="absolute -left-[3px] top-5 size-1.5 rounded-full bg-action"
                  />
                  <p className="font-mono text-xs uppercase tracking-widest text-ink">
                    {step.label}
                  </p>
                  <p className="mt-1.5 text-sm leading-relaxed text-muted">{step.value}</p>
                </li>
              ))}
            </ol>
          </aside>
        </div>
      </Reveal>

      <div className="mt-16 border-t border-hairline pt-8">
        <p className="font-mono text-xs uppercase tracking-widest text-muted">{copy.statsLabel}</p>
        <dl className="mt-6 grid grid-cols-2 gap-8 md:grid-cols-4">
          {stats.map((stat) => (
            <div key={stat.label}>
              <dt className="font-mono text-xs uppercase tracking-widest text-muted">
                {stat.label}
              </dt>
              <dd className="mt-2 text-2xl font-medium tracking-tight text-ink">
                <CountUp value={stat.value} />
              </dd>
            </div>
          ))}
        </dl>
        <p className="mt-6 font-mono text-xs text-muted">
          {format(state.stale ? common.stale : common.asOf, { date: formatDate(state.date) })}
        </p>
      </div>
    </Section>
  )
}
