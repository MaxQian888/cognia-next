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
    <ul className="grid gap-px bg-hairline md:grid-cols-2 xl:grid-cols-3">
      {entries.map((entry) => (
        <li key={entry.key} className={`flex flex-col p-6 md:p-8 ${cell}`}>
          <p className="font-medium text-ink">{entry.name}</p>
          <p className="mt-3 flex-1 text-sm leading-relaxed text-muted">{entry.body}</p>
          {entry.docsPath ? (
            <SiteLink
              target={{ label: learnMore, docsPath: entry.docsPath }}
              locale={locale}
              docsOrigin={docsOrigin}
              className="mt-6 inline-block font-mono text-xs text-ink underline decoration-hairline-strong underline-offset-4"
            />
          ) : null}
        </li>
      ))}
    </ul>
  )
}
