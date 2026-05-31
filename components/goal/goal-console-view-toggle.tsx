"use client"

/**
 * Grid / List toggle for the Goals console open-goals section. Mirrors
 * `components/scheduler/scheduler-dashboard-view-toggle.tsx` (same shadcn
 * `ToggleGroup` primitive) but is bound to `useGoalConsoleView`, which persists
 * the active mode to `AppSettings` (cross-device).
 *
 * Labels collapse to icon-only below `sm` so the toggle never crowds the
 * console header on narrow screens.
 */

import { useTranslations } from "next-intl"
import { LayoutGridIcon, Rows3Icon } from "lucide-react"

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  isGoalConsoleView,
  useGoalConsoleView,
  type GoalConsoleView,
} from "@/hooks/goal/use-goal-console-view"

export interface GoalConsoleViewToggleProps {
  className?: string
}

const ITEMS: { value: GoalConsoleView; icon: typeof LayoutGridIcon; key: string }[] = [
  { value: "grid", icon: LayoutGridIcon, key: "grid" },
  { value: "list", icon: Rows3Icon, key: "list" },
]

export function GoalConsoleViewToggle({ className }: GoalConsoleViewToggleProps) {
  const t = useTranslations("goal.console.view")
  const { view, setView } = useGoalConsoleView()

  return (
    <ToggleGroup
      type="single"
      size="sm"
      value={view}
      onValueChange={(value) => {
        if (isGoalConsoleView(value)) void setView(value)
      }}
      aria-label={t("aria")}
      className={className}
      data-testid="goal-console-view-toggle"
    >
      {ITEMS.map(({ value, icon: Icon, key }) => (
        <ToggleGroupItem
          key={value}
          value={value}
          aria-label={t(key)}
          data-testid={`goal-console-view-${value}`}
          className="gap-1.5"
        >
          <Icon className="size-3.5" aria-hidden="true" />
          <span className="hidden text-xs sm:inline">{t(key)}</span>
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}

GoalConsoleViewToggle.displayName = "GoalConsoleViewToggle"
