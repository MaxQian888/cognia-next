/**
 * Shared repo loader — fetches the full panel state for a repo and writes it
 * into the git store. Used by both the always-mounted StatusBar controller
 * (which owns the fs watcher) and the panel's refresh, so there is a single
 * code path that re-derives store state from the backend.
 */

import {
  gitBranches,
  gitConflicts,
  gitRepoState,
  gitStashList,
  gitStatus,
} from "@/lib/git/commands"
import { useGitStore } from "@/stores/git/git-store"
import { asGitError } from "@/types/git"

let fullLoadRequestId = 0
let statusRefreshRequestId = 0

function errorDetail(error: unknown): string {
  return asGitError(error)?.detail ?? (error instanceof Error ? error.message : String(error))
}

function isCurrentRoot(rootDir: string): boolean {
  return useGitStore.getState().rootDir === rootDir
}

/** Load repo state + status (+ branches/stashes/conflicts) into the store. */
export async function loadGitRepo(rootDir: string | null): Promise<void> {
  const requestId = ++fullLoadRequestId
  const store = useGitStore.getState()
  if (!rootDir) {
    store.setRepoState(null)
    store.setStatus(null)
    store.setLoadError(null)
    store.setLoadingStatus(false)
    return
  }
  if (!isCurrentRoot(rootDir)) return
  store.setLoadingStatus(true)
  store.setLoadError(null)
  try {
    const state = await gitRepoState(rootDir)
    if (requestId !== fullLoadRequestId || !isCurrentRoot(rootDir)) return
    store.setRepoState(state)
    if (!state.isRepo) {
      store.setStatus(null)
      store.setBranches([])
      store.setStashes([])
      store.setConflicts([])
      return
    }
    const [status, branches, stashes, conflicts] = await Promise.all([
      gitStatus(rootDir),
      gitBranches(rootDir),
      gitStashList(rootDir),
      gitConflicts(rootDir),
    ])
    if (requestId !== fullLoadRequestId || !isCurrentRoot(rootDir)) return
    store.setStatus(status)
    store.setBranches(branches)
    store.setStashes(stashes)
    store.setConflicts(conflicts)
  } catch (error) {
    if (requestId === fullLoadRequestId && isCurrentRoot(rootDir)) {
      useGitStore.getState().setLoadError(errorDetail(error))
    }
    throw error
  } finally {
    if (requestId === fullLoadRequestId && isCurrentRoot(rootDir)) {
      useGitStore.getState().setLoadingStatus(false)
    }
  }
}

/** Refresh only the status (lighter path for high-frequency watcher events). */
export async function refreshGitStatus(rootDir: string | null): Promise<void> {
  if (!rootDir) return
  const requestId = ++statusRefreshRequestId
  if (!isCurrentRoot(rootDir)) return
  const store = useGitStore.getState()
  store.setLoadError(null)
  try {
    const state = await gitRepoState(rootDir)
    if (requestId !== statusRefreshRequestId || !isCurrentRoot(rootDir)) return
    store.setRepoState(state)
    if (!state.isRepo) {
      store.setStatus(null)
      return
    }
    const [status, conflicts] = await Promise.all([gitStatus(rootDir), gitConflicts(rootDir)])
    if (requestId !== statusRefreshRequestId || !isCurrentRoot(rootDir)) return
    store.setStatus(status)
    store.setConflicts(conflicts)
  } catch (error) {
    if (requestId === statusRefreshRequestId && isCurrentRoot(rootDir)) {
      useGitStore.getState().setLoadError(errorDetail(error))
    }
    throw error
  }
}
