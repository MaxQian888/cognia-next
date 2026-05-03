"use client"

/**
 * ProviderSkeleton - Loading skeleton state for provider settings
 * Matches the design spec with animated placeholders
 */

import { Skeleton } from "@/components/ui/skeleton"
import { Card, CardContent, CardHeader } from "@/components/ui/card"

export function ProviderSkeleton() {
  return (
    <div className="space-y-6 animate-in fade-in duration-300">
      {/* Quick Overview Skeleton */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Skeleton className="h-5 w-5 rounded" />
              <Skeleton className="h-5 w-32" />
            </div>
            <Skeleton className="h-6 w-6 rounded" />
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <QuickStatSkeleton />
            <QuickStatSkeleton />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <SecondaryStatSkeleton />
            <SecondaryStatSkeleton />
            <SecondaryStatSkeleton />
          </div>
        </CardContent>
      </Card>

      {/* Page Header Skeleton */}
      <div className="flex items-center justify-between">
        <div className="space-y-2">
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-4 w-28" />
        </div>
        <div className="flex items-center gap-3">
          <Skeleton className="h-9 w-20 rounded-md" />
          <Skeleton className="h-9 w-28 rounded-md" />
        </div>
      </div>

      {/* Filter Row Skeleton */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1 p-1 bg-muted/50 rounded-lg">
          {[1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-7 w-16 rounded-md" />
          ))}
        </div>
        <div className="flex items-center gap-3">
          <Skeleton className="h-9 w-48 rounded-md" />
          <Skeleton className="h-9 w-20 rounded-md" />
        </div>
      </div>

      {/* Provider Cards Skeleton */}
      <div className="space-y-4">
        <ProviderCardSkeleton expanded />
        <ProviderCardSkeleton />
        <ProviderCardSkeleton />
      </div>
    </div>
  )
}

function QuickStatSkeleton() {
  return (
    <div className="flex items-center justify-between p-4 rounded-lg bg-muted/30 border">
      <div className="space-y-2">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-8 w-12" />
      </div>
      <Skeleton className="h-8 w-20 rounded-full" />
    </div>
  )
}

function SecondaryStatSkeleton() {
  return (
    <div className="p-3 rounded-lg bg-muted/20 border space-y-2">
      <Skeleton className="h-3 w-20" />
      <Skeleton className="h-5 w-24" />
    </div>
  )
}

function ProviderCardSkeleton({ expanded = false }: { expanded?: boolean }) {
  return (
    <Card>
      <CardHeader className="py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Skeleton className="h-10 w-10 rounded-lg" />
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Skeleton className="h-5 w-24" />
                <Skeleton className="h-5 w-16 rounded-full" />
              </div>
              <Skeleton className="h-3 w-48" />
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Skeleton className="h-5 w-10 rounded-full" />
            <Skeleton className="h-5 w-5" />
          </div>
        </div>
      </CardHeader>
      {expanded && (
        <CardContent className="pt-0 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Skeleton className="h-4 w-16" />
              <Skeleton className="h-10 w-full rounded-md" />
              <Skeleton className="h-3 w-32" />
            </div>
            <div className="space-y-2">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-10 w-full rounded-md" />
              <Skeleton className="h-3 w-40" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="p-4 rounded-lg bg-muted/20 border space-y-3">
              <div className="flex items-center justify-between">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-5 w-10 rounded-full" />
              </div>
              <div className="space-y-2">
                <Skeleton className="h-8 w-full rounded-md" />
                <Skeleton className="h-8 w-full rounded-md" />
              </div>
            </div>
            <div className="p-4 rounded-lg bg-muted/20 border space-y-3">
              <div className="flex items-center justify-between">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-3 w-20" />
              </div>
              <div className="flex flex-wrap gap-2">
                {[1, 2, 3, 4].map((i) => (
                  <Skeleton key={i} className="h-6 w-20 rounded-full" />
                ))}
              </div>
            </div>
          </div>
        </CardContent>
      )}
    </Card>
  )
}

export default ProviderSkeleton
