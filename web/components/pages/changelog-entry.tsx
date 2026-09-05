"use client"

import { useId, useState } from "react"
import { Icon, type IconName } from "@web/components/icon"
import type { ChangelogPageCopy } from "@web/content/types"
import type { Bump, ChangesetEntry } from "@web/lib/evidence"
import { formatDate } from "@web/lib/evidence"
import { parseBlocks, shouldFold } from "@web/lib/markdown-inline"
import { ChangelogMarkdown } from "./changelog-markdown"

interface ChangelogEntryProps {
  entry: ChangesetEntry
  copy: ChangelogPageCopy
}

const BUMP_ICON: Record<Bump, IconName> = {
  major: "bumpMajor",
  minor: "bumpMinor",
  patch: "bumpPatch",
}

const BUMP_CLASS: Record<Bump, string> = {
  major: "text-destructive",
  minor: "text-action",
  patch: "text-muted",
}

/**
 * One changeset, as a record: severity in a glyph and a word, the date, and
 * the body rendered from its Markdown.
 *
 * Long bodies open folded to their first block. Half the entries run past
 * 600 characters and the longest past 5,000, and printed in full they made the
 * page 180,000 pixels tall. The fold is a real button with the expanded state
 * exposed, and the full body is still in the DOM and findable with the
 * browser's own search, just clipped until asked for.
 */
export function ChangelogEntry({ entry, copy }: ChangelogEntryProps) {
  const blocks = parseBlocks(entry.summary)
  const foldable = shouldFold(blocks)
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  const folded = foldable && !open

  return (
    <li className="border-b border-hairline py-6">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span
          className={`flex items-center gap-1.5 font-mono text-xs uppercase tracking-widest ${BUMP_CLASS[entry.bump]}`}
        >
          <Icon name={BUMP_ICON[entry.bump]} size={14} />
          {copy.bumpLabels[entry.bump]}
        </span>
        <span className="font-mono text-xs text-muted">{formatDate(entry.date)}</span>
        <span className="ml-auto truncate font-mono text-[10px] text-stone">{entry.id}</span>
      </div>

      <div
        id={bodyId}
        data-folded={folded ? "" : undefined}
        className={`relative mt-3 max-w-3xl ${folded ? "max-h-[4.5rem] overflow-hidden" : ""}`}
      >
        <ChangelogMarkdown blocks={blocks} className="text-sm md:text-base" />
        {folded ? (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-linear-to-b from-transparent to-paper"
          />
        ) : null}
      </div>

      {foldable ? (
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-controls={bodyId}
          className="mt-3 inline-flex items-center gap-1.5 font-mono text-xs text-ink underline decoration-hairline-strong underline-offset-4 hover:decoration-ink"
        >
          <Icon name="chevronDown" size={14} className={open ? "rotate-180" : undefined} />
          {open ? copy.collapseEntry : copy.expandEntry}
        </button>
      ) : null}
    </li>
  )
}
