/**
 * The plugin contract's share of `lib/goal/console-prefs.ts`, which re-exports these.
 */
import type { GoalSortKey, SortDir } from "./history-filter"

/**
 * The console's tabs: three views of goals (`overview`, `history`,
 * `analytics`) and one place to configure them (`config`). Templates, defaults
 * and the tracker used to be tabs of their own, side by side with the views;
 * they are blocks of `config` now.
 */
export type GoalConsoleTab = "overview" | "history" | "analytics" | "config"

/** Fully-resolved console preferences (every field present). */
export interface GoalConsolePrefs {
  /** Tab the console opens on when no `?tab=` deep link is supplied. */
  defaultTab: GoalConsoleTab
  /** Initial sort column for the open-goals toolbar. */
  openGoalsSort: GoalSortKey
  /** Initial sort direction for the open-goals toolbar. */
  openGoalsDir: SortDir
}

/**
 * The persisted shape — every field optional (partial override of the
 * defaults). `defaultTab` is a plain string because rows written before the
 * tab merge can still hold `"templates"` / `"defaults"` / `"tracker"`.
 */
export type StoredGoalConsolePrefs = Partial<Omit<GoalConsolePrefs, "defaultTab">> & {
  defaultTab?: string
}
