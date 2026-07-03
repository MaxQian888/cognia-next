/**
 * Source Control panel preferences — the knobs that shape how the panel presents
 * diffs, guards destructive actions, automates commits, and keeps ahead/behind
 * fresh. Persisted on `AppSettings.gitSettings.panel` via `useSettingsStore.save()`
 * (same settings-singleton pattern as `discoverDefaults` / `executionMonitorPrefs`),
 * so the chosen view follows the user across devices with no Dexie migration.
 *
 * This module is a **leaf** — it imports nothing from `@/types/git`, so
 * `types/git/index.ts` can `import type` the partial shape here without a cycle.
 * Defaults are applied at read time by {@link resolveSourceControlPanelPrefs} so
 * existing installs (and forward-incompatible values) can never break the panel.
 */

/** Monaco diff rendering: two columns vs. a single inline column. */
export type DiffViewMode = "sideBySide" | "inline"
/** What the default Commit button chains after a successful commit. */
export type PostCommitAction = "none" | "push" | "sync"
/** Branch list ordering (client-side only — see note). */
export type BranchSortMode = "name" | "default"
/** Which Timeline view opens first. */
export type TimelineDefaultView = "list" | "graph"

export const DIFF_VIEW_MODES: readonly DiffViewMode[] = ["sideBySide", "inline"] as const
export const POST_COMMIT_ACTIONS: readonly PostCommitAction[] = ["none", "push", "sync"] as const
export const BRANCH_SORT_MODES: readonly BranchSortMode[] = ["name", "default"] as const
export const TIMELINE_DEFAULT_VIEWS: readonly TimelineDefaultView[] = ["list", "graph"] as const

/** Bounds for the background auto-fetch interval (minutes). */
export const AUTO_FETCH_INTERVAL_MIN = 1
export const AUTO_FETCH_INTERVAL_MAX = 60

/** Fully-resolved Source Control panel preferences (every field present). */
export interface SourceControlPanelPrefs {
  // --- Diff presentation ---
  /** Monaco `renderSideBySide`. */
  diffView: DiffViewMode
  /** Monaco `ignoreTrimWhitespace` — hide whitespace-only changes. */
  ignoreWhitespace: boolean

  // --- Guardrails ---
  /** Confirm before discarding a file's / all working-tree changes. */
  confirmDiscard: boolean
  /** Confirm before a force push (with lease). */
  confirmForcePush: boolean

  // --- Commit automation ---
  /** Stage all changes then commit when nothing is staged (VSCode smart-commit). */
  smartCommit: boolean
  /** Action chained after the default Commit button succeeds. */
  postCommit: PostCommitAction

  // --- Network defaults ---
  /** Plain Pull uses `--rebase`. */
  pullRebase: boolean
  /** Plain Fetch (and auto-fetch) uses `--prune`. */
  fetchPrune: boolean
  /** Background timer that periodically fetches — default off. */
  autoFetch: boolean
  /** Auto-fetch interval in minutes, clamped to [1, 60]. */
  autoFetchIntervalMinutes: number

  // --- List / history ---
  branchSort: BranchSortMode
  defaultTimelineView: TimelineDefaultView
}

/** All-optional partial as stored on `AppSettings.gitSettings.panel`. */
export type PartialSourceControlPanelPrefs = Partial<{
  diffView: string
  ignoreWhitespace: boolean
  confirmDiscard: boolean
  confirmForcePush: boolean
  smartCommit: boolean
  postCommit: string
  pullRebase: boolean
  fetchPrune: boolean
  autoFetch: boolean
  autoFetchIntervalMinutes: number
  branchSort: string
  defaultTimelineView: string
}>

/** Baseline defaults — chosen to preserve the current panel look/behavior. */
export const DEFAULT_SOURCE_CONTROL_PANEL_PREFS: SourceControlPanelPrefs = {
  diffView: "sideBySide",
  ignoreWhitespace: false,
  confirmDiscard: true,
  confirmForcePush: true,
  smartCommit: false,
  postCommit: "none",
  pullRebase: false,
  fetchPrune: false,
  autoFetch: false,
  autoFetchIntervalMinutes: 10,
  branchSort: "default",
  defaultTimelineView: "list",
}

function oneOf<T>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback
}

/** Clamp the auto-fetch interval to a whole number of minutes within bounds. */
export function clampAutoFetchInterval(value: unknown): number {
  const n =
    typeof value === "number" && Number.isFinite(value)
      ? Math.floor(value)
      : DEFAULT_SOURCE_CONTROL_PANEL_PREFS.autoFetchIntervalMinutes
  return Math.min(AUTO_FETCH_INTERVAL_MAX, Math.max(AUTO_FETCH_INTERVAL_MIN, n))
}

/**
 * Resolve the raw (possibly `undefined`/partial) stored value into a complete
 * `SourceControlPanelPrefs`, applying defaults and validating enum-ish fields so
 * a corrupt or forward-incompatible value can never break the panel. Pure — safe
 * to call from non-React contexts.
 */
export function resolveSourceControlPanelPrefs(
  raw: PartialSourceControlPanelPrefs | null | undefined
): SourceControlPanelPrefs {
  const d = DEFAULT_SOURCE_CONTROL_PANEL_PREFS
  if (!raw) return { ...d }
  return {
    diffView: oneOf<DiffViewMode>(raw.diffView, DIFF_VIEW_MODES, d.diffView),
    ignoreWhitespace: raw.ignoreWhitespace ?? d.ignoreWhitespace,
    confirmDiscard: raw.confirmDiscard ?? d.confirmDiscard,
    confirmForcePush: raw.confirmForcePush ?? d.confirmForcePush,
    smartCommit: raw.smartCommit ?? d.smartCommit,
    postCommit: oneOf<PostCommitAction>(raw.postCommit, POST_COMMIT_ACTIONS, d.postCommit),
    pullRebase: raw.pullRebase ?? d.pullRebase,
    fetchPrune: raw.fetchPrune ?? d.fetchPrune,
    autoFetch: raw.autoFetch ?? d.autoFetch,
    autoFetchIntervalMinutes:
      raw.autoFetchIntervalMinutes === undefined
        ? d.autoFetchIntervalMinutes
        : clampAutoFetchInterval(raw.autoFetchIntervalMinutes),
    branchSort: oneOf<BranchSortMode>(raw.branchSort, BRANCH_SORT_MODES, d.branchSort),
    defaultTimelineView: oneOf<TimelineDefaultView>(
      raw.defaultTimelineView,
      TIMELINE_DEFAULT_VIEWS,
      d.defaultTimelineView
    ),
  }
}

/** True when every knob is still at its factory default. */
export function isDefaultSourceControlPanelPrefs(prefs: SourceControlPanelPrefs): boolean {
  const d = DEFAULT_SOURCE_CONTROL_PANEL_PREFS
  return (
    prefs.diffView === d.diffView &&
    prefs.ignoreWhitespace === d.ignoreWhitespace &&
    prefs.confirmDiscard === d.confirmDiscard &&
    prefs.confirmForcePush === d.confirmForcePush &&
    prefs.smartCommit === d.smartCommit &&
    prefs.postCommit === d.postCommit &&
    prefs.pullRebase === d.pullRebase &&
    prefs.fetchPrune === d.fetchPrune &&
    prefs.autoFetch === d.autoFetch &&
    prefs.autoFetchIntervalMinutes === d.autoFetchIntervalMinutes &&
    prefs.branchSort === d.branchSort &&
    prefs.defaultTimelineView === d.defaultTimelineView
  )
}
