"use client"

import { useState } from "react"
import { format } from "@web/content"
import type { ChangelogPageCopy } from "@web/content/types"
import type { ChangelogGroup } from "@web/lib/evidence"
import { CHANGELOG_PAGE_SIZE, formatMonth, monthAnchor } from "@web/lib/evidence"
import type { Locale } from "@web/lib/locale"
import { ChangelogEntry } from "./changelog-entry"

interface ChangelogMonthProps {
  group: ChangelogGroup
  copy: ChangelogPageCopy
  locale: Locale
  /** The newest month opens by default. Older ones open when the reader asks. */
  defaultOpen?: boolean
}

const PAGE_SIZE = CHANGELOG_PAGE_SIZE

/**
 * One month of unreleased entries, as a disclosure with paging.
 *
 * `<details>` rather than a JS accordion, so the month opens and closes with
 * no hydration and stays keyboard-correct. Paging is state: a month of two
 * hundred entries mounting all at once is what made the page unusable, and a
 * reader who wants the rest asks for the next twenty rather than scrolling
 * through all of them.
 */
export function ChangelogMonth({ group, copy, locale, defaultOpen = false }: ChangelogMonthProps) {
  const [shown, setShown] = useState(PAGE_SIZE)
  const visible = group.entries.slice(0, shown)
  const remaining = group.entries.length - visible.length

  return (
    <details id={monthAnchor(group.key)} open={defaultOpen} className="group/month scroll-mt-24">
      <summary className="flex cursor-pointer list-none items-baseline justify-between gap-4 border-b border-hairline-strong pb-3 [&::-webkit-details-marker]:hidden">
        <h3 className="font-mono text-xs uppercase tracking-widest text-ink">
          {formatMonth(group.key, locale)}
        </h3>
        <span className="flex items-center gap-3 font-mono text-xs text-muted">
          {format(copy.entryCount, { count: group.entries.length })}
          <span
            aria-hidden
            className="inline-block transition-transform group-open/month:rotate-180"
          >
            ⌄
          </span>
        </span>
      </summary>

      <ul className="flex flex-col">
        {visible.map((entry) => (
          <ChangelogEntry key={entry.id} entry={entry} copy={copy} />
        ))}
      </ul>

      {remaining > 0 ? (
        <button
          type="button"
          onClick={() => setShown((value) => value + PAGE_SIZE)}
          className="mt-6 inline-flex h-10 items-center rounded-control border border-hairline-strong px-4 text-sm text-ink transition-colors hover:bg-surface"
        >
          {format(copy.showMoreEntries, { count: Math.min(remaining, PAGE_SIZE) })}
        </button>
      ) : null}
    </details>
  )
}
