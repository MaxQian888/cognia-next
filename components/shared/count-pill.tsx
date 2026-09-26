"use client"

/**
 * The count pill: "3 unread", "5 waiting", "2 filters on" — one component for
 * every count the navigation and the conversation lists draw, so they spell
 * the number the same way (`formatBadgeCount`: whole, capped at "99+") and
 * look the same.
 *
 * - `tone`: `solid` for a count that asks for attention (unread, waiting);
 *   `soft` for a tally that only informs (active filters in a section).
 * - `placement`: `inline` sits in a row; `corner` rides an icon button's
 *   top-right corner, outside the icon's optical square.
 * - Screen readers: a pill that is the only carrier of its count names it
 *   (`srLabel`, e.g. "3 unread"); a pill whose control already says the count
 *   in its accessible name is `decorative`. With neither, the digits are read
 *   as part of the surrounding name — fine where the context makes the
 *   number's meaning obvious.
 *
 * Renders nothing for zero or less.
 */

import { cn } from "@/lib/utils"
import { formatBadgeCount } from "@/lib/ui/badge-count"

export interface CountPillProps {
  count: number
  tone?: "solid" | "soft"
  placement?: "inline" | "corner"
  /** Spoken form, when the pill alone carries the count. */
  srLabel?: string
  /** The enclosing control's name already says the count. */
  decorative?: boolean
  className?: string
  testId?: string
}

const TONE_CLASS = {
  solid: "bg-primary text-primary-foreground",
  soft: "bg-primary/15 text-primary",
} as const

const PLACEMENT_CLASS = {
  inline: "inline-flex h-4 min-w-4 items-center justify-center px-1.5 text-[10px]",
  corner: "absolute -top-0.5 -right-0.5 min-w-4 px-1 py-px text-[9px] leading-[14px]",
} as const

export function CountPill({
  count,
  tone = "solid",
  placement = "inline",
  srLabel,
  decorative = false,
  className,
  testId,
}: CountPillProps) {
  if (count <= 0) return null
  const text = formatBadgeCount(count)
  return (
    <span
      aria-hidden={decorative || undefined}
      data-testid={testId}
      className={cn(
        "shrink-0 rounded-pill leading-none font-medium tabular-nums",
        PLACEMENT_CLASS[placement],
        TONE_CLASS[tone],
        className
      )}
    >
      {srLabel && !decorative ? (
        <>
          <span aria-hidden="true">{text}</span>
          <span className="sr-only">{srLabel}</span>
        </>
      ) : (
        text
      )}
    </span>
  )
}
