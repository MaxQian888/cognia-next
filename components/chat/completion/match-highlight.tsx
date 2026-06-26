// Renders a string with the characters at `positions` visually emphasized —
// used by the composer popover to show WHY a fuzzy candidate matched the query.
// Purely presentational: it takes the matched indices (from `fuzzyMatch` /
// `fuzzyFilterSortRanked`) and wraps exactly those code units in a <mark>.
//
// Contract: `positions` are indices into `text` (any order is tolerated; they
// are sorted + de-duped here). Out-of-range indices are ignored. An empty
// `positions` array renders `text` verbatim with no extra DOM weight.

import { Fragment, memo } from "react"
import { cn } from "@/lib/utils"

interface MatchHighlightProps {
  text: string
  /** Indices in `text` to emphasize. */
  positions: number[]
  /** Applied to the wrapper <span>. */
  className?: string
  /** Applied to each highlighted <mark>. Defaults to a semibold accent. */
  markClassName?: string
}

function MatchHighlightBase({ text, positions, className, markClassName }: MatchHighlightProps) {
  // Empty / no-positions fast path: a single text node, no marks.
  if (positions.length === 0) {
    return <span className={className}>{text}</span>
  }

  const hit = new Set(positions.filter((p) => p >= 0 && p < text.length))
  if (hit.size === 0) {
    return <span className={className}>{text}</span>
  }

  // Walk the string once, coalescing consecutive matched / unmatched runs so we
  // emit the minimum number of nodes (a `git/commit` match for `gc` becomes
  // <mark>g</mark>it/<mark>c</mark>ommit, not eight nodes).
  const runs: { matched: boolean; value: string }[] = []
  for (let i = 0; i < text.length; i++) {
    const matched = hit.has(i)
    const last = runs[runs.length - 1]
    if (last && last.matched === matched) {
      last.value += text[i]
    } else {
      runs.push({ matched, value: text[i] })
    }
  }

  return (
    <span className={className}>
      {runs.map((run, i) =>
        run.matched ? (
          <mark
            key={i}
            className={cn("bg-transparent font-semibold text-foreground", markClassName)}
          >
            {run.value}
          </mark>
        ) : (
          <Fragment key={i}>{run.value}</Fragment>
        )
      )}
    </span>
  )
}

export const MatchHighlight = memo(MatchHighlightBase)
