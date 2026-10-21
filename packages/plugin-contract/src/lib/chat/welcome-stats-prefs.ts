/**
 * The plugin contract's share of `lib/chat/welcome-stats-prefs.ts`, which re-exports these.
 */
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

/** Which face of the dashboard is showing. */
export type WelcomeStatsView = "overview" | "models"

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
