import { Section } from "@web/components/section"
import { SiteShell, evidence } from "@web/components/site-shell"
import { format, getCopy } from "@web/content"
import type { Bump } from "@web/lib/evidence"
import { formatDate, formatMonth, groupChangelog } from "@web/lib/evidence"
import type { Locale } from "@web/lib/locale"
import { docsUrl } from "@web/lib/site"
import { PageHeader } from "./page-header"

/**
 * `/changelog`.
 *
 * Generated from the repository, not remembered afterwards: unreleased entries
 * come from the changeset files (each written at the moment its change was
 * made) grouped by the month they landed, and released versions come from the
 * published release notes, which carry the same aggregated text.
 *
 * With no tagged release the page shows only the unreleased feed, and says so
 * — the repo's `CHANGELOG.md` is a stale scaffold and rendering it would put an
 * inaccurate history on a page whose whole value is accuracy.
 */
export function ChangelogPage({ locale }: { locale: Locale }) {
  const copy = getCopy(locale)
  const groups = groupChangelog(evidence.changesets)
  const released = evidence.releases.filter((release) => !release.prerelease)

  const bumpLabel: Record<Bump, string> = {
    major: copy.changelog.bumpLabels.major,
    minor: copy.changelog.bumpLabels.minor,
    patch: copy.changelog.bumpLabels.patch,
  }

  const bumpClass: Record<Bump, string> = {
    major: "text-destructive",
    minor: "text-action",
    patch: "text-muted",
  }

  return (
    <SiteShell locale={locale} route="/changelog">
      <PageHeader
        copy={copy.changelog.header}
        common={copy.common}
        locale={locale}
        docsOrigin={docsUrl()}
      />

      {released.length > 0 ? (
        <Section tone="paper">
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

      <Section tone={released.length > 0 ? "surface" : "paper"}>
        <div className="flex flex-wrap items-baseline justify-between gap-4">
          <h2 className="font-mono text-xs uppercase tracking-widest text-muted">
            {copy.changelog.unreleasedTitle}
          </h2>
          <p className="font-mono text-xs text-muted">
            {format(copy.changelog.entryCount, { count: evidence.changesets.length })}
          </p>
        </div>
        <p className="mt-6 max-w-2xl text-sm leading-relaxed text-muted">
          {copy.changelog.unreleasedNote}
        </p>

        {groups.length === 0 ? (
          <p className="mt-12 text-muted">{copy.changelog.emptyState}</p>
        ) : (
          <div className="mt-12 flex flex-col gap-16">
            {groups.map((group) => (
              <div key={group.key}>
                <h3 className="border-b border-hairline-strong pb-3 font-mono text-xs uppercase tracking-widest text-ink">
                  {formatMonth(group.key, locale)}
                </h3>
                <ul className="flex flex-col">
                  {group.entries.map((entry) => (
                    <li key={entry.id} className="border-b border-hairline py-6">
                      <div className="flex items-baseline gap-3">
                        <span
                          className={`font-mono text-xs uppercase tracking-widest ${bumpClass[entry.bump]}`}
                        >
                          {bumpLabel[entry.bump]}
                        </span>
                        <span className="font-mono text-xs text-muted">
                          {formatDate(entry.date)}
                        </span>
                      </div>
                      <p className="mt-3 max-w-3xl leading-relaxed text-ink">{entry.summary}</p>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </Section>
    </SiteShell>
  )
}
