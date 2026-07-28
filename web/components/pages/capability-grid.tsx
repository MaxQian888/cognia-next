import { RevealGroup, RevealItem } from "@web/components/reveal-group"
import { SiteLink } from "@web/components/site-link"
import type { CapabilityEntry } from "@web/content/types"
import type { Locale } from "@web/lib/locale"

interface CapabilityGridProps {
  entries: CapabilityEntry[]
  learnMore: string
  locale: Locale
  /** Cell background; must match the surrounding section's tone. */
  tone?: "paper" | "surface"
  docsOrigin?: string
}

/**
 * A gapless grid of capability cells. Shared by the sub-page sections and by
 * the use-case pages' "what this uses" block.
 *
 * An entry with no `docsPath` renders no link at all rather than one that goes
 * nowhere — the same rule the footer follows.
 *
 * Deliberately **no per-cell icon**. Nine icons in a three-by-three grid is a
 * feature matrix; this site is an editorial index, and the mark belongs on the
 * section (see `capability-sections.tsx`) rather than on every cell inside it.
 * The numbered index below is the site's own way of saying "these are records",
 * and it is derived from position, so it costs no content key.
 */
export function CapabilityGrid({
  entries,
  learnMore,
  locale,
  tone = "paper",
  docsOrigin,
}: CapabilityGridProps) {
  const cell = tone === "paper" ? "bg-paper" : "bg-surface"

  return (
    <RevealGroup
      as="ul"
      count={entries.length}
      className="grid gap-px bg-hairline md:grid-cols-2 xl:grid-cols-3"
    >
      {entries.map((entry, index) => (
        <RevealItem key={entry.key} as="li" className={`trace flex flex-col p-6 md:p-8 ${cell}`}>
          <span aria-hidden className="font-mono text-[10px] text-muted">
            {String(index + 1).padStart(2, "0")}
          </span>
          <p className="mt-3 font-medium text-ink">{entry.name}</p>
          <p className="mt-3 flex-1 text-sm leading-relaxed text-muted">{entry.body}</p>
          {entry.docsPath ? (
            <SiteLink
              target={{ label: learnMore, docsPath: entry.docsPath }}
              locale={locale}
              docsOrigin={docsOrigin}
              className="mt-6 inline-block font-mono text-xs text-ink underline decoration-hairline-strong underline-offset-4"
            />
          ) : null}
        </RevealItem>
      ))}
    </RevealGroup>
  )
}
