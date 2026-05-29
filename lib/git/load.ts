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

/** Load repo state + status (+ branches/stashes/conflicts) into the store. */
export async function loadGitRepo(rootDir: string | null): Promise<void> {
  const store = useGitStore.getState()
  if (!rootDir) {
    store.setRepoState(null)
    store.setStatus(null)
    return
  }
  store.setLoadingStatus(true)
  try {
    const state = await gitRepoState(rootDir)
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
    store.setStatus(status)
    store.setBranches(branches)
    store.setStashes(stashes)
    store.setConflicts(conflicts)
  } finally {
    useGitStore.getState().setLoadingStatus(false)
  }
}

/** Refresh only the status (lighter path for high-frequency watcher events). */
export async function refreshGitStatus(rootDir: string | null): Promise<void> {
  if (!rootDir) return
  const store = useGitStore.getState()
  const state = await gitRepoState(rootDir)
  store.setRepoState(state)
  if (!state.isRepo) {
    store.setStatus(null)
    return
  }
  const [status, conflicts] = await Promise.all([gitStatus(rootDir), gitConflicts(rootDir)])
  store.setStatus(status)
  store.setConflicts(conflicts)
}
