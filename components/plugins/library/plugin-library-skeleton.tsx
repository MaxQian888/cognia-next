"use client"

// Shared loading skeletons for the Library list/grid so the loading state
// matches the detail pane's skeleton treatment instead of a bare line of
// text. List = stacked rows; grid = card placeholders mirroring PluginCard.

import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"

export function PluginLibraryListSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="divide-y" aria-busy data-testid="plugin-library-list-skeleton">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex items-center gap-2 px-2 py-2">
          <Skeleton className="size-6 rounded-md" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3 w-40" />
            <Skeleton className="h-2.5 w-24" />
          </div>
          <Skeleton className="h-5 w-14 rounded-full" />
        </div>
      ))}
    </div>
  )
}

export function PluginLibraryGridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="@container/plugin-grid" aria-busy data-testid="plugin-library-grid-skeleton">
      <div className="grid gap-3 @lg/plugin-grid:grid-cols-2 @4xl/plugin-grid:grid-cols-3">
        {Array.from({ length: count }, (_, i) => (
          <Card key={i} className="space-y-3 p-3">
            <div className="flex items-center gap-2">
              <Skeleton className="size-7 rounded-md" />
              <div className="flex-1 space-y-1">
                <Skeleton className="h-3 w-32" />
                <Skeleton className="h-2.5 w-20" />
              </div>
            </div>
            <Skeleton className="h-3 w-full" />
            <div className="flex items-center justify-between pt-1">
              <Skeleton className="h-2.5 w-16" />
              <Skeleton className="h-5 w-16 rounded-full" />
            </div>
          </Card>
        ))}
      </div>
    </div>
  )
}
