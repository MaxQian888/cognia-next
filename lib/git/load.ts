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
  getGitOperationAvailability,
} from "@/lib/git/commands"
import { useGitStore } from "@/stores/git/git-store"
import { asGitError } from "@/types/git"

// Full loads and watcher refreshes compete to write the same repository
// snapshot. One shared generation prevents a slower, older request of either
// kind from overwriting a newer one.
let loadRequestId = 0

function errorDetail(error: unknown): string {
  return asGitError(error)?.detail ?? (error instanceof Error ? error.message : String(error))
}

function isCurrentRoot(rootDir: string): boolean {
  return useGitStore.getState().rootDir === rootDir
}

/** Load repo state + status (+ branches/stashes/conflicts) into the store. */
export async function loadGitRepo(rootDir: string | null): Promise<void> {
  const requestId = ++loadRequestId
  const store = useGitStore.getState()
  if (!rootDir) {
    store.setRepoState(null)
    store.setStatus(null)
    store.setBranches([])
    store.setStashes([])
    store.setConflicts([])
    store.setLoadError(null)
    store.setLoadingStatus(false)
    return
  }
  if (!isCurrentRoot(rootDir)) return
  store.setLoadingStatus(true)
  store.setLoadError(null)
  try {
    const state = await gitRepoState(rootDir)
    if (requestId !== loadRequestId || !isCurrentRoot(rootDir)) return

    // `Repository::discover` accepts a nested project directory. Bind the UI
    // to the discovered work-tree root it returns so watcher paths and every
    // repo-relative mutation share the same coordinate system.
    if (state.isRepo && state.rootDir && state.rootDir !== rootDir) {
      store.setRootDir(state.rootDir)
      await loadGitRepo(state.rootDir)
      return
    }
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
      getGitOperationAvailability("git_branches").state === "available"
        ? gitBranches(rootDir)
        : Promise.resolve([]),
      getGitOperationAvailability("git_stash_list").state === "available"
        ? gitStashList(rootDir)
        : Promise.resolve([]),
      getGitOperationAvailability("git_conflicts").state === "available"
        ? gitConflicts(rootDir)
        : Promise.resolve([]),
    ])
    if (requestId !== loadRequestId || !isCurrentRoot(rootDir)) return
    store.setStatus(status)
    store.setBranches(branches)
    store.setStashes(stashes)
    store.setConflicts(conflicts)
  } catch (error) {
    if (requestId === loadRequestId && isCurrentRoot(rootDir)) {
      useGitStore.getState().setLoadError(errorDetail(error))
    }
    throw error
  } finally {
    if (requestId === loadRequestId && isCurrentRoot(rootDir)) {
      useGitStore.getState().setLoadingStatus(false)
    }
  }
}

/** Refresh all mutable repository lists after a debounced watcher event. */
export async function refreshGitStatus(rootDir: string | null): Promise<void> {
  if (!rootDir) return
  const requestId = ++loadRequestId
  if (!isCurrentRoot(rootDir)) return
  const store = useGitStore.getState()
  store.setLoadError(null)
  try {
    const state = await gitRepoState(rootDir)
    if (requestId !== loadRequestId || !isCurrentRoot(rootDir)) return
    if (state.isRepo && state.rootDir && state.rootDir !== rootDir) {
      store.setRootDir(state.rootDir)
      await loadGitRepo(state.rootDir)
      return
    }
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
      getGitOperationAvailability("git_branches").state === "available"
        ? gitBranches(rootDir)
        : Promise.resolve([]),
      getGitOperationAvailability("git_stash_list").state === "available"
        ? gitStashList(rootDir)
        : Promise.resolve([]),
      getGitOperationAvailability("git_conflicts").state === "available"
        ? gitConflicts(rootDir)
        : Promise.resolve([]),
    ])
    if (requestId !== loadRequestId || !isCurrentRoot(rootDir)) return
    store.setStatus(status)
    store.setBranches(branches)
    store.setStashes(stashes)
    store.setConflicts(conflicts)
  } catch (error) {
    if (requestId === loadRequestId && isCurrentRoot(rootDir)) {
      useGitStore.getState().setLoadError(errorDetail(error))
    }
    throw error
  } finally {
    // A watcher refresh can supersede a full load that set this flag. Since
    // this refresh now derives the same complete mutable snapshot, it also owns
    // clearing the superseded load indicator.
    if (requestId === loadRequestId && isCurrentRoot(rootDir)) {
      useGitStore.getState().setLoadingStatus(false)
    }
  }
}
