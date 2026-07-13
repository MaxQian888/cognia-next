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
 * Uses `useState` + `subscribeRecentErrorLogs` (rather than
 * `useSyncExternalStore`) because `getRecentErrorLogs` returns a fresh array
 * slice on every call, which would violate the snapshot-stability contract.
 */

import { useEffect, useState } from "react"
import { ChevronDown } from "lucide-react"

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { getRecentErrorLogs, subscribeRecentErrorLogs } from "@cognia/logging/recent-errors"
import { LEVEL_THEME } from "@cognia/logging/level-theme"
import { cn } from "@/lib/utils"
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

const CASCADE_THRESHOLD = 3
const CASCADE_WINDOW_MS = 5000

function readEntries(limit: number, currentErrorId?: string): StructuredLogEntry[] {
  const all = getRecentErrorLogs(limit + (currentErrorId ? 1 : 0))
  const filtered = currentErrorId ? all.filter((entry) => entry.id !== currentErrorId) : all
  return filtered.slice(0, limit)
}

/** True when ≥3 of the entries landed within a 5s window. */
export function isCascading(entries: StructuredLogEntry[]): boolean {
  if (entries.length < CASCADE_THRESHOLD) return false
  const times = entries
    .map((entry) => Date.parse(entry.timestamp))
    .filter((value) => !Number.isNaN(value))
  if (times.length < CASCADE_THRESHOLD) return false
  return Math.max(...times) - Math.min(...times) <= CASCADE_WINDOW_MS
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
  const [entries, setEntries] = useState<StructuredLogEntry[]>(() =>
    readEntries(limit, currentErrorId)
  )

  useEffect(() => {
    const update = () => setEntries(readEntries(limit, currentErrorId))
    update()
    return subscribeRecentErrorLogs(update)
  }, [limit, currentErrorId])

  if (entries.length === 0) {
    return null
  }

  const cascading = isCascading(entries)

  return (
    <Collapsible
      className={cn("w-full rounded-md border bg-muted/30 text-left", className)}
      data-testid="recent-errors-panel"
    >
      <CollapsibleTrigger
        className="group flex w-full items-center justify-between gap-2 px-3 py-2 text-sm font-medium"
        data-testid="recent-errors-toggle"
      >
        <span className="flex items-center gap-2">
          {copy.title}
          <span className="rounded-full bg-muted px-1.5 text-xs text-muted-foreground">
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
            className="mx-3 mb-2 rounded bg-destructive/10 px-2 py-1 text-xs text-destructive"
            data-testid="recent-errors-cascade"
          >
            {copy.cascadeHint}
          </p>
        )}
        <ul className="flex flex-col gap-1 px-3 pb-3 text-xs">
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
