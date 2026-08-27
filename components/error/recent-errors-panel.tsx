"use client"

/**
 * Recent-errors context panel for the error page.
 *
 * Reads the in-memory recent-error stream (`lib/logging/recent-errors`) that the
 * logging core already maintains, so a user staring at a crash can see whether
 * it's an isolated failure or one of a cascade. When several errors land inside
 * a short window it surfaces a "cascading errors" hint. Hidden entirely when
 * there's nothing to show.
 *
 * Reads the buffer through `useRecentErrorLogs`, which is the render-safe read:
 * recent errors are recorded on the console bridge's synchronous path, so a
 * `console.error` raised during any render notifies subscribers mid-render, and
 * a `useState` subscriber there is React's "Cannot update a component while
 * rendering a different component". The rows are a `useMemo` over that snapshot
 * rather than a second copy in state.
 */

import { useMemo } from "react"
import { ChevronDown } from "lucide-react"

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { LEVEL_THEME } from "@cognia/logging/level-theme"
import { useRecentErrorLogs } from "@/hooks/logging/use-recent-error-logs"
import { cn } from "@/lib/utils"
import { isCascadingIso } from "@/lib/diagnostics/cascade"
import type { StructuredLogEntry } from "@/types/logging"

export interface RecentErrorsCopy {
  title: string
  cascadeHint: string
}

export interface RecentErrorsPanelProps {
  copy: RecentErrorsCopy
  /** Exclude the current boundary error (matched by id) from the list. */
  currentErrorId?: string
  /** Max rows to show. Default 5. */
  limit?: number
  className?: string
}

/** Derived from the whole buffer, not from a pre-sliced window: dropping the
 * boundary error first is what keeps the panel at `limit` rows even when that
 * error is not one of the newest few. */
function selectEntries(
  all: StructuredLogEntry[],
  limit: number,
  currentErrorId?: string
): StructuredLogEntry[] {
  const filtered = currentErrorId ? all.filter((entry) => entry.id !== currentErrorId) : all
  return filtered.slice(0, limit)
}

/**
 * True when ≥3 of the entries landed within a 5s window.
 *
 * The rule now lives in `lib/diagnostics/cascade.ts` so the diagnostic router
 * suppresses a burst by the same definition this panel uses to label one.
 * Re-exported because the panel's own tests (and callers) already import it here.
 */
export function isCascading(entries: StructuredLogEntry[]): boolean {
  return isCascadingIso(entries.map((entry) => entry.timestamp))
}

function formatTime(timestamp: string): string {
  const parsed = Date.parse(timestamp)
  if (Number.isNaN(parsed)) return timestamp
  return new Date(parsed).toLocaleTimeString()
}

export function RecentErrorsPanel({
  copy,
  currentErrorId,
  limit = 5,
  className,
}: RecentErrorsPanelProps) {
  const recentErrors = useRecentErrorLogs()
  const entries = useMemo(
    () => selectEntries(recentErrors, limit, currentErrorId),
    [recentErrors, limit, currentErrorId]
  )

  if (entries.length === 0) {
    return null
  }

  const cascading = isCascading(entries)

  return (
    <Collapsible className={cn("w-full text-left", className)} data-testid="recent-errors-panel">
      <CollapsibleTrigger
        className="group flex w-full items-center justify-between gap-2 px-5 py-3 text-sm font-medium transition-colors hover:bg-muted/40"
        data-testid="recent-errors-toggle"
      >
        <span className="flex items-center gap-2">
          {copy.title}
          <span className="rounded-pill bg-muted px-1.5 text-xs tabular-nums text-muted-foreground">
            {entries.length}
          </span>
        </span>
        <ChevronDown
          className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180"
          aria-hidden="true"
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        {cascading && (
          <p
            className="mb-2 border-l-2 border-destructive/60 px-5 py-1 text-xs text-destructive"
            data-testid="recent-errors-cascade"
          >
            {copy.cascadeHint}
          </p>
        )}
        <ul className="flex flex-col gap-1.5 px-5 pb-4 text-xs">
          {entries.map((entry) => {
            const theme = LEVEL_THEME[entry.level]
            const Icon = theme.icon
            return (
              <li
                key={entry.id}
                className="flex items-start gap-2"
                data-testid="recent-errors-item"
              >
                <Icon
                  className={cn("mt-0.5 size-3.5 shrink-0", theme.iconColor)}
                  aria-hidden="true"
                />
                <span className="shrink-0 font-mono text-muted-foreground">
                  {formatTime(entry.timestamp)}
                </span>
                <span className="line-clamp-2 flex-1 break-words">{entry.message}</span>
                <span className="shrink-0 text-muted-foreground">{entry.module}</span>
              </li>
            )
          })}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  )
}
