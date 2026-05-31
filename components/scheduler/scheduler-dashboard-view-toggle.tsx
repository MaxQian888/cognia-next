"use client"

/**
 * Overview / Calendar / Timeline toggle for the scheduler dashboard. Mirrors
 * `components/discover/discover-view-toggle.tsx` (same shadcn `ToggleGroup`
 * primitive) but is bound to `useSchedulerDashboardView`, which persists the
 * single active mode to `AppSettings` (cross-device).
 *
 * Labels collapse to icon-only below `sm` so the toggle never crowds the
 * dashboard header on narrow screens.
 */

import { useTranslations } from "next-intl"
import { CalendarDaysIcon, LayoutDashboardIcon, ListOrderedIcon } from "lucide-react"

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  isSchedulerDashboardView,
  useSchedulerDashboardView,
  type SchedulerDashboardView,
} from "@/hooks/scheduler/use-scheduler-dashboard-view"

export interface SchedulerDashboardViewToggleProps {
  className?: string
}

const ITEMS: { value: SchedulerDashboardView; icon: typeof LayoutDashboardIcon; key: string }[] = [
  { value: "overview", icon: LayoutDashboardIcon, key: "overview" },
  { value: "calendar", icon: CalendarDaysIcon, key: "calendar" },
  { value: "timeline", icon: ListOrderedIcon, key: "timeline" },
]

export function SchedulerDashboardViewToggle({ className }: SchedulerDashboardViewToggleProps) {
  const t = useTranslations("scheduler.dashboardView")
  const { view, setView } = useSchedulerDashboardView()

  return (
    <ToggleGroup
      type="single"
      size="sm"
      value={view}
      onValueChange={(value) => {
        if (isSchedulerDashboardView(value)) void setView(value)
      }}
      aria-label={t("aria")}
      className={className}
      data-testid="scheduler-dashboard-view-toggle"
    >
      {ITEMS.map(({ value, icon: Icon, key }) => (
        <ToggleGroupItem
          key={value}
          value={value}
          aria-label={t(key)}
          data-testid={`scheduler-dashboard-view-${value}`}
          className="gap-1.5"
        >
          <Icon className="size-3.5" aria-hidden="true" />
          <span className="hidden text-xs sm:inline">{t(key)}</span>
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
