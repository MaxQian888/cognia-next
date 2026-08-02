/**
 * Preferences for the chat welcome page's usage dashboard
 * (`components/chat/welcome/welcome-stats.tsx`).
 *
 * Persisted on `AppSettings.welcomeStats` via the settings singleton — the same
 * pattern as `welcomeStyle` / `goalConsolePrefs`, so the layout follows the user
 * across devices without a Dexie migration. `resolveWelcomeStatsPrefs` folds a
 * partial (or corrupt / forward-migrated) stored blob over the hard defaults and
 * is the only read side, so an unknown tile id can never crash the welcome page.
 *
 * Pure + dependency-free on purpose: the component, the settings card, and the
 * tests all resolve through this one function.
 */

/** One tile in the stat grid. Order here is the render order. */
export type WelcomeStatId =
  | "sessions"
  | "turns"
  | "tokens"
  | "cost"
  | "activeDays"
  | "currentStreak"
  | "longestStreak"
  | "peakHour"
  | "topModel"

/** Every tile the customizer offers, in canonical order. */
export const WELCOME_STAT_IDS: readonly WelcomeStatId[] = [
  "sessions",
  "turns",
  "tokens",
  "cost",
  "activeDays",
  "currentStreak",
  "longestStreak",
  "peakHour",
  "topModel",
]

/** Which face of the dashboard is showing. */
export type WelcomeStatsView = "overview" | "models"

export const WELCOME_STATS_VIEWS: readonly WelcomeStatsView[] = ["overview", "models"]

/**
 * Selectable trailing windows, in days. Identical to the Usage tab's `RANGES`
 * on purpose — `sessionUsage` is pruned to 90 days, so an "all time" option
 * would promise history the table cannot hold, and the two surfaces must offer
 * the same windows to be comparable at a glance.
 */
export const WELCOME_STATS_RANGE_DAYS: readonly number[] = [7, 30, 90]

/** Fully-resolved preferences (every field present). */
export interface WelcomeStatsPrefs {
  /** Master switch. `false` hides the whole panel (the ✕ on its header). */
  enabled: boolean
  /** Trailing local-calendar window the panel aggregates over. */
  rangeDays: number
  /** Active face: the stat grid or the per-model breakdown. */
  view: WelcomeStatsView
  /** Tiles to render, in canonical order. Empty ⇒ the grid is skipped. */
  tiles: WelcomeStatId[]
  /** Draw the calendar heatmap under the stat grid. */
  heatmap: boolean
}

/** The persisted shape — every field optional. */
export type StoredWelcomeStatsPrefs = Partial<Omit<WelcomeStatsPrefs, "tiles">> & {
  tiles?: string[]
}

/**
 * Hard defaults. Eight tiles fill the 2/4-column grid exactly at every
 * breakpoint; `cost` is in and `longestStreak` is out because a single "how
 * much did this cost me" number earns its place on a landing screen more than a
 * second streak counter does. Both stay one click away in the customizer.
 */
export const DEFAULT_WELCOME_STATS_PREFS: WelcomeStatsPrefs = {
  enabled: true,
  rangeDays: 30,
  view: "overview",
  tiles: [
    "sessions",
    "turns",
    "tokens",
    "cost",
    "activeDays",
    "currentStreak",
    "peakHour",
    "topModel",
  ],
  heatmap: true,
}

/** Type guard for a stored tile id (drops ids removed by a later version). */
export function isWelcomeStatId(value: unknown): value is WelcomeStatId {
  return typeof value === "string" && (WELCOME_STAT_IDS as readonly string[]).includes(value)
}

/**
 * Fold a partial stored blob over {@link DEFAULT_WELCOME_STATS_PREFS}. Unknown
 * enum values fall back to the default; the tile list is filtered to known ids,
 * de-duplicated, and re-sorted into canonical order so the grid never depends on
 * the order the customizer happened to write. An explicitly emptied tile list is
 * honoured (the user turned every tile off) — only a missing/invalid one falls
 * back to the defaults.
 */
export function resolveWelcomeStatsPrefs(
  stored: StoredWelcomeStatsPrefs | null | undefined
): WelcomeStatsPrefs {
  const tiles = Array.isArray(stored?.tiles)
    ? WELCOME_STAT_IDS.filter((id) => stored!.tiles!.includes(id))
    : DEFAULT_WELCOME_STATS_PREFS.tiles

  return {
    enabled: typeof stored?.enabled === "boolean" ? stored.enabled : true,
    rangeDays:
      typeof stored?.rangeDays === "number" && WELCOME_STATS_RANGE_DAYS.includes(stored.rangeDays)
        ? stored.rangeDays
        : DEFAULT_WELCOME_STATS_PREFS.rangeDays,
    view:
      stored?.view && (WELCOME_STATS_VIEWS as readonly string[]).includes(stored.view)
        ? stored.view
        : DEFAULT_WELCOME_STATS_PREFS.view,
    tiles: [...tiles],
    heatmap: typeof stored?.heatmap === "boolean" ? stored.heatmap : true,
  }
}
