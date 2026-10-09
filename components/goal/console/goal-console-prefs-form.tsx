"use client"

/**
 * Console preferences for `/goals` (ADR-0019): the tab the console opens on
 * and how open goals sort by default. A block of the Configure tab — it used
 * to be a gear popover in the header, a third place to configure goals next to
 * the Templates / Defaults / Tracker tabs.
 *
 * Writes go straight through `useGoalConsolePrefs.setPrefs` (merge + persist to
 * `AppSettings.goalConsolePrefs`), so there is no draft to keep in sync and no
 * Save button: each choice applies as it is made.
 */

import { useTranslations } from "next-intl"

import { SettingsField } from "@/components/settings/common/settings-block"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useGoalConsolePrefs } from "@/hooks/goal/use-goal-console-prefs"
import { GOAL_CONSOLE_TABS, type GoalConsoleTab } from "@/lib/goal/console-prefs"
import type { GoalSortKey, SortDir } from "@/lib/goal/history-filter"

const SORT_KEYS: readonly GoalSortKey[] = ["created", "turns", "tokens"]
const DIRS: readonly SortDir[] = ["desc", "asc"]

export function GoalConsolePrefsForm() {
  const t = useTranslations("goal")
  const { prefs, setPrefs } = useGoalConsolePrefs()

  return (
    <div className="space-y-4" data-testid="goal-console-prefs">
      <SettingsField
        htmlFor="goal-console-prefs-default-tab"
        label={t("console.prefs.defaultTab")}
        description={t("console.prefs.defaultTabHint")}
      >
        <Select
          value={prefs.defaultTab}
          onValueChange={(value) => void setPrefs({ defaultTab: value as GoalConsoleTab })}
        >
          <SelectTrigger
            id="goal-console-prefs-default-tab"
            className="w-44"
            data-testid="goal-console-prefs-default-tab"
          >
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
      </SettingsField>

      <SettingsField
        htmlFor="goal-console-prefs-sort"
        label={t("console.prefs.openGoalsSort")}
        description={t("console.prefs.openGoalsSortHint")}
      >
        <div className="flex gap-2">
          <Select
            value={prefs.openGoalsSort}
            onValueChange={(value) => void setPrefs({ openGoalsSort: value as GoalSortKey })}
          >
            <SelectTrigger
              id="goal-console-prefs-sort"
              className="w-32"
              data-testid="goal-console-prefs-sort"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SORT_KEYS.map((key) => (
                <SelectItem key={key} value={key}>
                  {t(`history.sort${key.charAt(0).toUpperCase()}${key.slice(1)}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={prefs.openGoalsDir}
            onValueChange={(value) => void setPrefs({ openGoalsDir: value as SortDir })}
          >
            <SelectTrigger
              className="w-28"
              aria-label={t("console.prefs.direction")}
              data-testid="goal-console-prefs-dir"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DIRS.map((dir) => (
                <SelectItem key={dir} value={dir}>
                  {t(dir === "asc" ? "history.dirAsc" : "history.dirDesc")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </SettingsField>
    </div>
  )
}

GoalConsolePrefsForm.displayName = "GoalConsolePrefsForm"
