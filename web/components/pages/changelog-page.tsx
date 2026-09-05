import { Section } from "@web/components/section"
import { SiteShell, evidence } from "@web/components/site-shell"
import { format, getCopy } from "@web/content"
import type { Bump } from "@web/lib/evidence"
import { bumpCounts, formatDate, formatMonth, groupChangelog, monthAnchor } from "@web/lib/evidence"
import type { Locale } from "@web/lib/locale"
import { docsUrl } from "@web/lib/site"
import { ChangelogMonth } from "./changelog-month"
import { PageHeader } from "./page-header"

const BUMP_ORDER: Bump[] = ["major", "minor", "patch"]

const BUMP_FILL: Record<Bump, string> = {
  major: "bg-destructive",
  minor: "bg-action",
  patch: "bg-hairline-strong",
}

/**
 * `/changelog`.
 *
 * Generated from the repository, not remembered afterwards: unreleased entries
 * come from the changeset files (each written at the moment its change was
 * made) grouped by the month they landed, and released versions come from the
 * published release notes, which carry the same aggregated text.
 *
 * With no tagged release the page shows only the unreleased feed, and says so.
 * The repo's `CHANGELOG.md` is a stale scaffold and rendering it would put an
 * inaccurate history on a page whose whole value is accuracy.
 *
 * The feed is a column of month disclosures beside a sticky index: how the
 * pending changes divide across the three bump levels, and a link to each
 * month. Both were declared in the copy long before anything rendered them.
 */
export function ChangelogPage({ locale }: { locale: Locale }) {
  const copy = getCopy(locale)
  const groups = groupChangelog(evidence.changesets)
  const released = evidence.releases.filter((release) => !release.prerelease)
  const counts = bumpCounts(evidence.changesets)
  const total = evidence.changesets.length

  return (
    <SiteShell locale={locale} route="/changelog">
      <PageHeader
        copy={copy.changelog.header}
        common={copy.common}
        locale={locale}
        docsOrigin={docsUrl()}
      />

      {released.length > 0 ? (
        <Section tone="paper" density="tight">
          <h2 className="font-mono text-xs uppercase tracking-widest text-muted">
            {copy.changelog.releasedTitle}
          </h2>
          <ol className="mt-8 flex flex-col gap-px bg-hairline">
            {released.map((release) => (
              <li key={release.tagName} className="bg-paper py-8">
                <div className="flex flex-wrap items-baseline gap-4">
                  <h3 className="text-2xl font-medium tracking-tight text-ink">{release.name}</h3>
                  <p className="font-mono text-xs text-muted">{formatDate(release.publishedAt)}</p>
                </div>
                {release.body ? (
                  <p className="mt-4 max-w-3xl whitespace-pre-line leading-relaxed text-muted">
                    {release.body}
                  </p>
                ) : null}
              </li>
            ))}
          </ol>
        </Section>
      ) : null}

      <Section tone={released.length > 0 ? "surface" : "paper"} density="tight">
        <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,16rem)] lg:gap-16">
          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline justify-between gap-4">
              <h2 className="font-mono text-xs uppercase tracking-widest text-muted">
                {copy.changelog.unreleasedTitle}
              </h2>
              <p className="font-mono text-xs text-muted">
                {format(copy.changelog.entryCount, { count: total })}
              </p>
            </div>
            <p className="mt-6 max-w-2xl text-sm leading-relaxed text-muted">
              {copy.changelog.unreleasedNote}
            </p>

            {groups.length === 0 ? (
              <p className="mt-12 text-muted">{copy.changelog.emptyState}</p>
            ) : (
              <div className="mt-12 flex flex-col gap-12">
                {groups.map((group, index) => (
                  <ChangelogMonth
                    key={group.key}
                    group={group}
                    copy={copy.changelog}
                    locale={locale}
                    defaultOpen={index === 0}
                  />
                ))}
              </div>
            )}
          </div>

          {groups.length > 0 ? (
            <aside className="mt-12 lg:mt-0 lg:self-start lg:sticky lg:top-24">
              <p className="font-mono text-xs uppercase tracking-widest text-muted">
                {copy.changelog.distributionLabel}
              </p>
              {/* The three-segment bar. A segment's width is its share, and the
               * count beside the label carries the number, so nothing rests on
               * the fill colour alone. */}
              <div
                role="img"
                aria-label={BUMP_ORDER.map(
                  (bump) => `${copy.changelog.bumpLabels[bump]} ${counts[bump]}`
                ).join(", ")}
                className="mt-4 flex h-1.5 w-full gap-px overflow-hidden rounded-full bg-hairline"
              >
                {BUMP_ORDER.map((bump) =>
                  counts[bump] > 0 ? (
                    <span
                      key={bump}
                      className={`h-full ${BUMP_FILL[bump]}`}
                      style={{ width: `${(counts[bump] / Math.max(total, 1)) * 100}%` }}
                    />
                  ) : null
                )}
              </div>
              <dl className="mt-4 flex flex-col gap-px bg-hairline">
                {BUMP_ORDER.map((bump) => (
                  <div key={bump} className="flex items-center gap-3 bg-paper py-2">
                    <span aria-hidden className={`size-1.5 rounded-full ${BUMP_FILL[bump]}`} />
                    <dt className="font-mono text-xs uppercase tracking-widest text-muted">
                      {copy.changelog.bumpLabels[bump]}
                    </dt>
                    <dd className="ml-auto font-mono text-xs tabular-nums text-ink">
                      {counts[bump]}
                    </dd>
                  </div>
                ))}
              </dl>

              <nav aria-label={copy.changelog.monthIndexLabel} className="mt-10">
                <p className="font-mono text-xs uppercase tracking-widest text-muted">
                  {copy.changelog.monthIndexLabel}
                </p>
                <ul className="mt-4 flex flex-col gap-px bg-hairline">
                  {groups.map((group) => (
                    <li key={group.key} className="bg-paper">
                      <a
                        href={`#${monthAnchor(group.key)}`}
                        className="trace flex items-baseline justify-between gap-3 py-2.5 text-sm text-ink transition-colors hover:text-muted"
                      >
                        {formatMonth(group.key, locale)}
                        <span className="font-mono text-xs tabular-nums text-muted">
                          {group.entries.length}
                        </span>
                      </a>
                    </li>
                  ))}
                </ul>
              </nav>
            </aside>
          ) : null}
        </div>
      </Section>
    </SiteShell>
  )
}
