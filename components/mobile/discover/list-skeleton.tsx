"use client"

/**
 * Lightweight placeholder for the mobile Discover legacy card lists
 * (characters / teams / skills) while their first Dexie read is in flight.
 *
 * Without this the lists rendered their EmptyState ("No characters yet") for
 * the brief loading window, which read as "actually empty" rather than
 * "still loading". Mirrors the row shape of `CharacterCard` / `TeamCard` /
 * `SkillCard` (a 48px media square + two text lines) so the swap to real
 * content doesn't shift layout.
 */

import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

export interface ListSkeletonProps {
  /** Number of placeholder rows. Defaults to 4. */
  rows?: number
  className?: string
}

export function ListSkeleton({ rows = 4, className }: ListSkeletonProps) {
  return (
    <div
      className={cn("flex flex-col gap-2", className)}
      role="status"
      aria-busy="true"
      data-testid="discover-list-skeleton"
    >
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className="flex items-center gap-3 rounded-md border border-border bg-card p-3"
        >
          <Skeleton className="size-12 shrink-0 rounded-md" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-3 w-3/4" />
          </div>
        </div>
      ))}
    </div>
  )
}
