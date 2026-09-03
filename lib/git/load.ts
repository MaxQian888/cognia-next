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
  gitStackParents,
  gitStashList,
  gitStatus,
  gitWorktreeList,
  getGitOperationAvailability,
} from "@/lib/git/commands"
import { useGitStore } from "@/stores/git/git-store"
import { asGitError } from "@/types/git"
import type { GitBranch, GitConflict, GitStashEntry, GitStatus, GitWorktree } from "@/types/git"
import { createLogger } from "@cognia/logging"

const log = createLogger("git.load")

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

/** Everything one repository snapshot writes into the store. */
interface RepoLists {
  status: GitStatus
  branches: GitBranch[]
  stashes: GitStashEntry[]
  conflicts: GitConflict[]
  worktrees: GitWorktree[]
  stackParents: Array<[string, string]>
}

/**
 * Read one repository snapshot.
 *
 * The first four reads share a bare `Promise.all` because the panel is
 * meaningless without any of them: if status fails, there is nothing to show
 * and the caller must surface the error.
 *
 * The last two are deliberately NOT in it. They annotate the branch list
 * rather than constituting the panel, so one of them rejecting must cost the
 * annotation, not the snapshot. That is not hypothetical: `git_worktree_list`
 * answered `contract_output_violation` on every companion until its response
 * schema was corrected, and it will keep answering that against any host
 * still running the older contract. An empty list reads as "placement
 * unknown", which is exactly the behaviour that predates this field.
 */
async function readRepoLists(rootDir: string): Promise<RepoLists> {
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
  const [worktrees, stackParents] = await Promise.all([
    getGitOperationAvailability("git_worktree_list").state === "available"
      ? gitWorktreeList(rootDir).catch((error: unknown) => {
          log.warn("worktree_list_failed", { detail: errorDetail(error) })
          return [] as GitWorktree[]
        })
      : Promise.resolve([] as GitWorktree[]),
    getGitOperationAvailability("git_stack_parents").state === "available"
      ? gitStackParents(rootDir).catch((error: unknown) => {
          log.warn("stack_parents_failed", { detail: errorDetail(error) })
          return [] as Array<[string, string]>
        })
      : Promise.resolve([] as Array<[string, string]>),
  ])
  return { status, branches, stashes, conflicts, worktrees, stackParents }
}

/** Write one snapshot into the store. */
function writeRepoLists(lists: RepoLists): void {
  const store = useGitStore.getState()
  store.setStatus(lists.status)
  store.setBranches(lists.branches)
  store.setStashes(lists.stashes)
  store.setConflicts(lists.conflicts)
  store.setWorktrees(lists.worktrees)
  store.setStackParents(lists.stackParents)
}

/** Clear every backend-derived list, for a directory that is not a repo. */
function clearRepoLists(): void {
  const store = useGitStore.getState()
  store.setStatus(null)
  store.setBranches([])
  store.setStashes([])
  store.setConflicts([])
  store.setWorktrees([])
  store.setStackParents([])
}

/** Load repo state + status (+ branches/stashes/conflicts) into the store. */
export async function loadGitRepo(rootDir: string | null): Promise<void> {
  const requestId = ++loadRequestId
  const store = useGitStore.getState()
  if (!rootDir) {
    store.setRepoState(null)
    clearRepoLists()
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
      clearRepoLists()
      return
    }
    const lists = await readRepoLists(rootDir)
    if (requestId !== loadRequestId || !isCurrentRoot(rootDir)) return
    writeRepoLists(lists)
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
      clearRepoLists()
      return
    }
    const lists = await readRepoLists(rootDir)
    if (requestId !== loadRequestId || !isCurrentRoot(rootDir)) return
    writeRepoLists(lists)
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
