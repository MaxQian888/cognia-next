"use client"

import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"

/**
 * Skeleton grid shown while the marketplace is loading. Mirrors the
 * 1-/2-/3-column container-query layout of `<PluginMarketplace>`'s card
 * grid so the layout doesn't shift when real entries arrive. Keyed to the
 * grid's own width (`@container/plugin-grid`), not the viewport, for the
 * same reason — see the marketplace grid comment.
 */
export function PluginMarketplaceSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="@container/plugin-grid" data-testid="plugin-marketplace-skeleton" aria-busy>
      <div className="grid gap-3 @lg/plugin-grid:grid-cols-2 @4xl/plugin-grid:grid-cols-3">
        {Array.from({ length: count }, (_, i) => (
          <Card key={i} className="gap-0 py-0">
            <CardHeader className="flex flex-row items-center gap-2 px-4 pt-4">
              <Skeleton className="size-8 rounded-md" />
              <div className="flex flex-1 flex-col gap-1">
                <Skeleton className="h-3 w-32" />
                <Skeleton className="h-2.5 w-16" />
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 px-4 py-3">
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-4/5" />
            </CardContent>
            <CardFooter className="justify-between px-4 pb-4 pt-1">
              <Skeleton className="h-2.5 w-16" />
              <Skeleton className="h-7 w-20" />
            </CardFooter>
          </Card>
        ))}
      </div>
    </div>
  )
}
