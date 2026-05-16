"use client"

import { useTranslations } from "next-intl"
import { Skeleton } from "@/components/ui/skeleton"

interface SchedulerSkeletonProps {
  variant?: "full" | "sidebar" | "dashboard"
}

/**
 * Replaces the global `RefreshCw` spinner during scheduler initialization with
 * a layout-matching skeleton. Showing the actual page shape (sidebar + KPI
 * cards + execution chart placeholder) prevents the perceived jump when data
 * lands.
 */
export function SchedulerSkeleton({ variant = "full" }: SchedulerSkeletonProps) {
  const t = useTranslations("scheduler")
  if (variant === "sidebar") {
    return <SidebarSkeleton />
  }
  if (variant === "dashboard") {
    return <DashboardSkeleton />
  }
  return (
    <div
      data-testid="scheduler-skeleton-full"
      className="flex h-full w-full"
      role="status"
      aria-label={t("loadingScheduler")}
    >
      <div className="hidden border-r sm:block sm:w-64">
        <SidebarSkeleton />
      </div>
      <div className="flex-1 overflow-hidden">
        <DashboardSkeleton />
      </div>
    </div>
  )
}

function SidebarSkeleton() {
  return (
    <div data-testid="scheduler-skeleton-sidebar" className="space-y-3 p-3">
      <div className="flex items-center gap-2">
        <Skeleton className="h-4 w-4 rounded" />
        <Skeleton className="h-4 flex-1" />
      </div>
      <Skeleton className="h-8 w-full" />
      <div className="flex gap-1.5">
        <Skeleton className="h-6 w-12" />
        <Skeleton className="h-6 w-16" />
        <Skeleton className="h-6 w-16" />
      </div>
      <div className="space-y-1.5 pt-2">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-9 w-full" />
        ))}
      </div>
    </div>
  )
}

function DashboardSkeleton() {
  return (
    <div data-testid="scheduler-skeleton-dashboard" className="space-y-5 p-5 sm:p-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-24 w-full rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-56 w-full rounded-xl" />
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Skeleton className="h-48 w-full rounded-xl" />
        <Skeleton className="h-48 w-full rounded-xl" />
      </div>
    </div>
  )
}
