/**
 * The plugin contract's share of `lib/execution/monitor-prefs.ts`, which re-exports these.
 */
/** Shape stored on the settings singleton (every field optional / untrusted). */
export type StoredExecutionMonitorPrefs = Partial<{
  hiddenKinds: string[]
  sort: string
  groupByKind: boolean
  showElapsed: boolean
}>
