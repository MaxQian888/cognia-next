"use client"

import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"

/**
 * Skeleton grid shown while the marketplace is loading. Mirrors the
 * 1-/2-/3-column responsive layout of `<PluginMarketplace>`'s card
 * grid so the layout doesn't shift when real entries arrive.
 */
export function PluginMarketplaceSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div
      className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3"
      data-testid="plugin-marketplace-skeleton"
      aria-busy
    >
      {Array.from({ length: count }, (_, i) => (
        <Card key={i} className="p-4 space-y-3">
          <div className="flex items-center gap-2">
            <Skeleton className="size-8 rounded-md" />
            <div className="flex-1 space-y-1">
              <Skeleton className="h-3 w-32" />
              <Skeleton className="h-2.5 w-16" />
            </div>
          </div>
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-4/5" />
          <div className="flex items-center justify-between pt-1">
            <Skeleton className="h-2.5 w-16" />
            <Skeleton className="h-7 w-20" />
          </div>
        </Card>
      ))}
    </div>
  )
}
