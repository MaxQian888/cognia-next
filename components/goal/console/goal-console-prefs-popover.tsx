"use client"

/**
 * Console preferences gear for the `/goals` Mission Control header
 * (ADR-0019 Phase 3). A compact Popover that edits the persisted
 * `goalConsolePrefs`: the default landing tab and the open-goals default sort.
 * Mirrors the settings-gear pattern used by the Discover / Scheduler / Log
 * consoles. Writes flow straight through `useGoalConsolePrefs.setPrefs` (which
 * merges + persists), so there's no local draft to keep in sync.
 */

import { useTranslations } from "next-intl"

import { AnimatedActionIcon } from "@/components/shared/animated-action-icon"
import { Button } from "@/components/ui/button"
import { SettingsIcon as AnimatedSettingsIcon } from "@/components/ui/settings"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { GoalSortKey, SortDir } from "@/lib/goal/history-filter"
import { GOAL_CONSOLE_TABS, type GoalConsoleTab } from "@/lib/goal/console-prefs"
import { useGoalConsolePrefs } from "@/hooks/goal/use-goal-console-prefs"

const SORT_KEYS: readonly GoalSortKey[] = ["created", "turns", "tokens"]
const DIRS: readonly SortDir[] = ["desc", "asc"]

export function GoalConsolePrefsPopover() {
  const t = useTranslations("goal")
  const { prefs, setPrefs } = useGoalConsolePrefs()

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          aria-label={t("console.prefs.title")}
          data-testid="goal-console-prefs-trigger"
        >
          <AnimatedActionIcon icon={AnimatedSettingsIcon} size={16} />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 space-y-4" data-testid="goal-console-prefs">
        <div>
          <h3 className="text-sm font-semibold">{t("console.prefs.title")}</h3>
          <p className="text-xs text-muted-foreground">{t("console.prefs.description")}</p>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs font-medium">{t("console.prefs.defaultTab")}</Label>
          <Select
            value={prefs.defaultTab}
            onValueChange={(v) => void setPrefs({ defaultTab: v as GoalConsoleTab })}
          >
            <SelectTrigger data-testid="goal-console-prefs-default-tab">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {GOAL_CONSOLE_TABS.map((tab) => (
                <SelectItem key={tab} value={tab}>
                  {t(`console.tabs.${tab}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs font-medium">{t("console.prefs.openGoalsSort")}</Label>
          <div className="flex gap-2">
            <Select
              value={prefs.openGoalsSort}
              onValueChange={(v) => void setPrefs({ openGoalsSort: v as GoalSortKey })}
            >
              <SelectTrigger className="flex-1" data-testid="goal-console-prefs-sort">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SORT_KEYS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {t(`history.sort${k.charAt(0).toUpperCase()}${k.slice(1)}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={prefs.openGoalsDir}
              onValueChange={(v) => void setPrefs({ openGoalsDir: v as SortDir })}
            >
              <SelectTrigger className="w-28" data-testid="goal-console-prefs-dir">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DIRS.map((d) => (
                  <SelectItem key={d} value={d}>
                    {t(d === "asc" ? "history.dirAsc" : "history.dirDesc")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

GoalConsolePrefsPopover.displayName = "GoalConsolePrefsPopover"
