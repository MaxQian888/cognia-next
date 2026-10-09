"use client"

/**
 * Grid / List toggle for the Goals console open-goals section. A shadcn
 * `ToggleGroup` bound to `useGoalConsoleView`, which persists the active mode
 * to `AppSettings` (cross-device).
 *
 * Icon-only, each with its label as the accessible name and a tooltip: the
 * toggle sits on the section heading row, where two worded buttons competed
 * with the heading for attention.
 */

import { useTranslations } from "next-intl"
import { LayoutGridIcon, Rows3Icon } from "lucide-react"

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  isGoalConsoleView,
  useGoalConsoleView,
  type GoalConsoleView,
} from "@/hooks/goal/use-goal-console-view"

export interface GoalConsoleViewToggleProps {
  className?: string
}

const ITEMS: { value: GoalConsoleView; icon: typeof LayoutGridIcon; key: string }[] = [
  { value: "list", icon: Rows3Icon, key: "list" },
  { value: "grid", icon: LayoutGridIcon, key: "grid" },
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
        <Tooltip key={value}>
          <TooltipTrigger asChild>
            <ToggleGroupItem
              value={value}
              aria-label={t(key)}
              data-testid={`goal-console-view-${value}`}
              className="size-7 px-0"
            >
              <Icon className="size-3.5" aria-hidden="true" />
            </ToggleGroupItem>
          </TooltipTrigger>
          <TooltipContent>{t(key)}</TooltipContent>
        </Tooltip>
      ))}
    </ToggleGroup>
  )
}

GoalConsoleViewToggle.displayName = "GoalConsoleViewToggle"
