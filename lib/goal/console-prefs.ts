/**
 * Preferences + tab model for the `/goals` "Mission Control" console
 * (ADR-0019 Phase 3).
 *
 * Two concerns live here so both stay pure + unit-tested without rendering:
 *
 *  1. The segmented-tab identity (`GoalConsoleTab` + guard) — mirrors
 *     `lib/pet/console-tabs.ts`. The console's top segmented tab bar and the
 *     static-export `?tab=` deep link both resolve against it.
 *  2. The persisted console preferences (`GoalConsolePrefs`) — the default
 *     landing tab and the open-goals default sort. Persisted on
 *     `AppSettings.goalConsolePrefs` via the settings singleton (same pattern
 *     as `goalConsoleView`), so choices follow the user across devices with no
 *     Dexie migration. `resolveGoalConsolePrefs` folds a partial stored blob
 *     over the hard defaults — the single read side for every consumer.
 */

import type { GoalSortKey, SortDir } from "@/lib/goal/history-filter"

// ─────────────────────────────────────────────────────────────────────────────
// Tabs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The console sections. `overview` is the live-operations dashboard (stat row +
 * open goals); the other five are the management sections. All six render as a
 * single top-level segmented tab bar (mirrors `/performance`).
 */
export type GoalConsoleTab =
  | "overview"
  | "history"
  | "analytics"
  | "templates"
  | "defaults"
  | "tracker"

/** Canonical tab order — also the render order of the tab bar. */
export const GOAL_CONSOLE_TABS: readonly GoalConsoleTab[] = [
  "overview",
  "history",
  "analytics",
  "templates",
  "defaults",
  "tracker",
]

/** Type guard for a `?tab=` param / bridge navigation (which yields `string`). */
export function isGoalConsoleTab(value: string | null | undefined): value is GoalConsoleTab {
  return value != null && (GOAL_CONSOLE_TABS as readonly string[]).includes(value)
}

// ─────────────────────────────────────────────────────────────────────────────
// Preferences
// ─────────────────────────────────────────────────────────────────────────────

/** Fully-resolved console preferences (every field present). */
export interface GoalConsolePrefs {
  /** Tab the console opens on when no `?tab=` deep link is supplied. */
  defaultTab: GoalConsoleTab
  /** Initial sort column for the open-goals toolbar. */
  openGoalsSort: GoalSortKey
  /** Initial sort direction for the open-goals toolbar. */
  openGoalsDir: SortDir
}

/** The persisted shape — every field optional (partial override of the defaults). */
export type StoredGoalConsolePrefs = Partial<GoalConsolePrefs>

/** Hard defaults applied when `AppSettings.goalConsolePrefs` is absent. */
export const DEFAULT_GOAL_CONSOLE_PREFS: GoalConsolePrefs = {
  defaultTab: "overview",
  openGoalsSort: "created",
  openGoalsDir: "desc",
}

const VALID_SORTS: readonly GoalSortKey[] = ["created", "turns", "tokens"]
const VALID_DIRS: readonly SortDir[] = ["asc", "desc"]

/**
 * Fold a (possibly partial / malformed) stored blob over the hard defaults.
 * Unknown enum values are ignored (fall back to the default) so a corrupt or
 * forward-migrated settings row can never crash the console.
 */
export function resolveGoalConsolePrefs(
  stored: StoredGoalConsolePrefs | null | undefined
): GoalConsolePrefs {
  return {
    defaultTab: isGoalConsoleTab(stored?.defaultTab)
      ? stored!.defaultTab!
      : DEFAULT_GOAL_CONSOLE_PREFS.defaultTab,
    openGoalsSort:
      stored?.openGoalsSort && VALID_SORTS.includes(stored.openGoalsSort)
        ? stored.openGoalsSort
        : DEFAULT_GOAL_CONSOLE_PREFS.openGoalsSort,
    openGoalsDir:
      stored?.openGoalsDir && VALID_DIRS.includes(stored.openGoalsDir)
        ? stored.openGoalsDir
        : DEFAULT_GOAL_CONSOLE_PREFS.openGoalsDir,
  }
}
