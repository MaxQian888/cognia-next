/**
 * The one heading style the triage pane uses between its sections: a small
 * muted label, the same treatment as the chat header overflow's groups, so the
 * pane reads as headed sections on one ground rather than a stack of cards.
 */

import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

export function TriageSectionHeading({
  id,
  children,
  className,
  trailing,
}: {
  id?: string
  children: ReactNode
  className?: string
  /** Optional right-aligned content (a count, a small action). */
  trailing?: ReactNode
}) {
  return (
    <div className={cn("flex min-h-8 items-center gap-2 px-4 pt-3 pb-1", className)}>
      <h3
        id={id}
        className="min-w-0 flex-1 truncate text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
      >
        {children}
      </h3>
      {trailing}
    </div>
  )
}
