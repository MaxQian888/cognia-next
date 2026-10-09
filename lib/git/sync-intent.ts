/**
 * The one network action the Source Control header offers first, read from the
 * branch's tracking state.
 *
 * The header used to show four bare icons (sync, pull, push, fetch) side by
 * side, two of them arrows that differed only in direction, so the user had to
 * know git to know which one they wanted. The state already answers it: a
 * branch with nothing upstream is published, one that is only behind is
 * pulled, only ahead is pushed, both is synchronized, and an up-to-date (or
 * detached) one is fetched to find out whether it still is.
 */

export type SyncIntent = "publish" | "sync" | "pull" | "push" | "fetch"

export interface SyncState {
  /** `null` when HEAD is detached. */
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
}

export function resolveSyncIntent({ branch, upstream, ahead, behind }: SyncState): SyncIntent {
  if (branch === null) return "fetch"
  if (upstream === null) return "publish"
  if (ahead > 0 && behind > 0) return "sync"
  if (behind > 0) return "pull"
  if (ahead > 0) return "push"
  return "fetch"
}
