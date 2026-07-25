"use client"

/**
 * Loading skeleton for the provider settings pane, shown until the Dexie-backed
 * settings hydrate (`provider-settings.tsx`, gated on `settingsLoaded`).
 *
 * Shaped like the layout it actually precedes: a fixed 320px provider rail
 * beside a detail pane with a tab strip. It previously drew a single column of
 * stacked "provider cards" — the shape of an older layout — so the moment real
 * settings landed the whole page changed form rather than filling in.
 *
 * Mirrors `provider-settings.tsx`'s own responsive rules: the rail is hidden
 * below `md` (where the real UI moves the list into a Sheet) and a compact
 * mobile bar stands in for the Sheet trigger.
 */

import { Skeleton } from "@/components/ui/skeleton"

export function ProviderSkeleton() {
  return (
    <div className="flex h-full min-h-0 flex-col gap-4 animate-in fade-in duration-300">
      {/* Onboarding banner slot — reserved so its later arrival doesn't shove
          the grid down. */}
      <Skeleton className="h-16 w-full shrink-0 rounded-lg" />

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 md:grid-cols-[320px_1fr]">
        <SidebarSkeleton />
        <MobileBarSkeleton />
        <DetailPaneSkeleton />
      </div>
    </div>
  )
}

/** The 320px rail: search + category tabs + provider rows. */
function SidebarSkeleton() {
  return (
    <div className="hidden min-h-0 md:flex md:flex-col md:overflow-hidden md:rounded-lg md:border">
      <div className="space-y-3 border-b p-3">
        <div className="flex items-center gap-2">
          <Skeleton className="h-8 flex-1 rounded-md" />
          <Skeleton className="h-8 w-8 shrink-0 rounded-md" />
        </div>
        <div className="flex gap-1">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-6 flex-1 rounded-md" />
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-1.5 overflow-hidden p-2">
        {[0, 1, 2, 3, 4, 5, 6].map((i) => (
          <ProviderRowSkeleton key={i} />
        ))}
      </div>
    </div>
  )
}

function ProviderRowSkeleton() {
  return (
    <div className="flex items-center gap-2.5 rounded-md px-2 py-2">
      <Skeleton className="size-8 shrink-0 rounded-lg" />
      <div className="min-w-0 flex-1 space-y-1.5">
        <Skeleton className="h-3.5 w-24" />
        <Skeleton className="h-2.5 w-32" />
      </div>
      <Skeleton className="size-2 shrink-0 rounded-full" />
    </div>
  )
}

/** Below `md` the rail collapses to a Sheet trigger plus the active name. */
function MobileBarSkeleton() {
  return (
    <div className="flex items-center gap-2 md:hidden">
      <Skeleton className="h-8 w-28 shrink-0 rounded-md" />
      <Skeleton className="h-4 w-40" />
    </div>
  )
}

/** Detail pane: header row, tab strip, then a form body. */
function DetailPaneSkeleton() {
  return (
    <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border">
      <div className="flex items-center justify-between gap-3 border-b p-4">
        <div className="flex min-w-0 items-center gap-3">
          <Skeleton className="size-10 shrink-0 rounded-lg" />
          <div className="space-y-2">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-3 w-44" />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Skeleton className="h-5 w-10 rounded-full" />
          <Skeleton className="h-8 w-8 rounded-md" />
        </div>
      </div>

      <div className="flex gap-1 border-b px-4 py-2">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-7 w-20 rounded-md" />
        ))}
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-hidden p-4">
        <FieldSkeleton />
        <FieldSkeleton />
        <FieldSkeleton short />
        <Skeleton className="h-9 w-32 rounded-md" />
      </div>
    </div>
  )
}

function FieldSkeleton({ short = false }: { short?: boolean }) {
  return (
    <div className="space-y-2">
      <Skeleton className="h-4 w-24" />
      <Skeleton className={short ? "h-9 w-1/2 rounded-md" : "h-9 w-full rounded-md"} />
      <Skeleton className="h-3 w-40" />
    </div>
  )
}

export default ProviderSkeleton
