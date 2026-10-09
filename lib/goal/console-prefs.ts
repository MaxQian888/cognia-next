/**
 * Preferences + tab model for the `/goals` console (ADR-0019 Phase 3).
 *
 * Two concerns live here so both stay pure + unit-tested without rendering:
 *
 *  1. The tab identity (`GoalConsoleTab` + guard) and the address of a place
 *     inside the console (`resolveGoalConsoleLocation`). The header's tab
 *     strip and the static-export `?tab=` deep link both resolve against it.
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
 * The console's tabs: three views of goals (`overview`, `history`,
 * `analytics`) and one place to configure them (`config`). Templates, defaults
 * and the tracker used to be tabs of their own, side by side with the views;
 * they are blocks of `config` now.
 */
export type GoalConsoleTab = "overview" | "history" | "analytics" | "config"

/** Canonical tab order — also the render order of the tab strip. */
export const GOAL_CONSOLE_TABS: readonly GoalConsoleTab[] = [
  "overview",
  "history",
  "analytics",
  "config",
]

/** Type guard for a `?tab=` param / bridge navigation (which yields `string`). */
export function isGoalConsoleTab(value: string | null | undefined): value is GoalConsoleTab {
  return value != null && (GOAL_CONSOLE_TABS as readonly string[]).includes(value)
}

/** The blocks of the `config` tab, in render order. */
export type GoalConfigSection = "defaults" | "templates" | "tracker" | "console"

export const GOAL_CONFIG_SECTIONS: readonly GoalConfigSection[] = [
  "defaults",
  "templates",
  "tracker",
  "console",
]

export function isGoalConfigSection(value: string | null | undefined): value is GoalConfigSection {
  return value != null && (GOAL_CONFIG_SECTIONS as readonly string[]).includes(value)
}

/**
 * Tabs that no longer exist but still arrive: in `?tab=` links written before
 * the merge (the Settings launcher, plugin bridges, bookmarks) and in a
 * persisted `defaultTab`. Each one is a block of `config` now.
 */
const RETIRED_TAB_SECTION: Readonly<Record<string, GoalConfigSection>> = {
  templates: "templates",
  defaults: "defaults",
  tracker: "tracker",
}

/** A place inside the console: a tab, and for `config` the block to show. */
export interface GoalConsoleLocation {
  tab: GoalConsoleTab
  section?: GoalConfigSection
}

/**
 * Resolve a `?tab=` value (current or retired) to a location. `null` for a
 * missing or unknown value, so the caller falls back to the user's default.
 * `section` (`?section=`) only applies to the `config` tab.
 */
export function resolveGoalConsoleLocation(
  tab: string | null | undefined,
  section?: string | null
): GoalConsoleLocation | null {
  // `Object.hasOwn`, not `in`: `in` also matches inherited names, so a
  // `?tab=constructor` link resolved to a "section" that was a function.
  if (tab != null && Object.hasOwn(RETIRED_TAB_SECTION, tab)) {
    return { tab: "config", section: RETIRED_TAB_SECTION[tab] }
  }
  if (!isGoalConsoleTab(tab)) return null
  if (tab === "config" && isGoalConfigSection(section)) return { tab, section }
  return { tab }
}

export const GOAL_CONSOLE_ROUTE = "/goals"

/**
 * The address of a console place: `?tab=` (and `?section=` for `config`) plus
 * `?goal=` for the goal shown in the inspector. A selection is an address so
 * a scheduler run, a conversation row or a copied link can open one goal, and
 * Back closes what a click opened. With no tab, the console opens on the
 * user's default tab.
 */
export function goalConsoleHref(
  place: { tab?: GoalConsoleTab; section?: GoalConfigSection; goalId?: string | null } = {}
): string {
  const params = new URLSearchParams()
  if (place.tab) params.set("tab", place.tab)
  if (place.tab === "config" && place.section) params.set("section", place.section)
  if (place.goalId) params.set("goal", place.goalId)
  const query = params.toString()
  return query ? `${GOAL_CONSOLE_ROUTE}?${query}` : GOAL_CONSOLE_ROUTE
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

/**
 * The persisted shape — every field optional (partial override of the
 * defaults). `defaultTab` is a plain string because rows written before the
 * tab merge can still hold `"templates"` / `"defaults"` / `"tracker"`.
 */
export type StoredGoalConsolePrefs = Partial<Omit<GoalConsolePrefs, "defaultTab">> & {
  defaultTab?: string
}

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
 * forward-migrated settings row can never crash the console; a retired tab
 * resolves to the tab that absorbed it.
 */
export function resolveGoalConsolePrefs(
  stored: StoredGoalConsolePrefs | null | undefined
): GoalConsolePrefs {
  return {
    defaultTab:
      resolveGoalConsoleLocation(stored?.defaultTab)?.tab ?? DEFAULT_GOAL_CONSOLE_PREFS.defaultTab,
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
