/**
 * The plugin contract's share of `lib/git/panel-prefs.ts`, which re-exports these.
 */
/** All-optional partial as stored on `AppSettings.gitSettings.panel`. */
export type PartialSourceControlPanelPrefs = Partial<{
  diffView: string
  ignoreWhitespace: boolean
  collapseUnchanged: boolean
  diffWordWrap: boolean
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
