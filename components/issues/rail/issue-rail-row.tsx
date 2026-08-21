"use client"

/**
 * A single selectable row in the issue rail.
 *
 * Shared by all three sections so a view, a project and a label cannot drift
 * into three different heights and hover treatments. `active` is expressed with
 * `aria-pressed` rather than a link's `aria-current` because every row in this
 * rail is a filter toggle, not a destination — clicking a project narrows the
 * board in place, it does not navigate.
 */

import type { ReactNode } from "react"

import { cn } from "@/lib/utils"

export interface IssueRailRowProps {
  active: boolean
  onSelect: () => void
  icon?: ReactNode
  label: string
  /** Right-aligned tally. Omitted rather than rendered as 0 when unknown. */
  count?: number
  /** Full-width slot under the label, e.g. a project's progress bar. */
  detail?: ReactNode
  /** Revealed on hover/focus, e.g. "open in the projects console". */
  trailing?: ReactNode
  testId?: string
}

export function IssueRailRow({
  active,
  onSelect,
  icon,
  label,
  count,
  detail,
  trailing,
  testId,
}: IssueRailRowProps) {
  return (
    <div className="group/rail-row relative">
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={active}
        data-testid={testId}
        className={cn(
          "flex w-full min-w-0 flex-col gap-1 rounded-md px-2 py-1.5 text-left",
          "motion-safe:transition-colors motion-safe:duration-150",
          "hover:bg-accent/60 focus-visible:ring-ring/50 focus-visible:outline-none focus-visible:ring-[3px]",
          active && "bg-accent"
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          {icon}
          <span className="min-w-0 flex-1 truncate text-sm">{label}</span>
          {count !== undefined ? (
            <span
              className={cn(
                "shrink-0 text-xs tabular-nums text-muted-foreground",
                // Make room for the trailing control on hover instead of
                // letting the two overlap.
                trailing && "group-hover/rail-row:invisible"
              )}
            >
              {count}
            </span>
          ) : null}
        </span>
        {detail}
      </button>
      {trailing ? (
        <span className="absolute right-1.5 top-1.5 opacity-0 transition-opacity group-focus-within/rail-row:opacity-100 group-hover/rail-row:opacity-100">
          {trailing}
        </span>
      ) : null}
    </div>
  )
}
