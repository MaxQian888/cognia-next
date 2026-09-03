"use client"

/**
 * Source Control store. Holds the active repo binding and all backend-derived
 * panel state. Persistence is deliberately narrow (`partialize`): only the UI
 * shape survives reloads — every backend-derived field is transient and
 * re-fetched fresh, so the panel never shows stale repo state. Mirrors the
 * persist/partialize/DEFAULTS/BOUNDS conventions of `stores/terminal` and
 * `stores/ui`.
 */

import { create } from "zustand"
import { persist } from "zustand/middleware"
import { persistLocalStorage } from "@/stores/persist-storage"
import type {
  GitBranch,
  GitWorktree,
  GitCommit,
  GitConflict,
  GitDiff,
  GitRepoState,
  GitStashEntry,
  GitStatus,
  GitStatusGroup,
} from "@/types/git"

/** In-flight operation keys (drive spinners + disable buttons). */
export type GitOp =
  | "status"
  | "commit"
  | "push"
  | "pull"
  | "fetch"
  | "sync"
  | "stage"
  | "unstage"
  | "checkout"
  | "stash"
  | "discard"
  | "restore"
  | "resolve"
  | "branch"
  | "remote"
  | "tag"
  | "reset"
  | "sequence"
  | "ignore"

export type TimelineScope = "repo" | "file"

export const GIT_DEFAULTS = {
  commitBoxRows: 3,
} as const

export const GIT_BOUNDS = {
  /** Max cached file diffs before LRU eviction. */
  diffCacheMax: 50,
} as const

const DEFAULT_EXPANDED: Record<GitStatusGroup, boolean> = {
  merge: true,
  staged: true,
  changes: true,
}

function emptyOps(): Record<GitOp, boolean> {
  return {
    status: false,
    commit: false,
    push: false,
    pull: false,
    fetch: false,
    sync: false,
    stage: false,
    unstage: false,
    checkout: false,
    stash: false,
    discard: false,
    restore: false,
    resolve: false,
    branch: false,
    remote: false,
    tag: false,
    reset: false,
    sequence: false,
    ignore: false,
  }
}

/**
 * Whether two worktree lists describe the same thing, for the identity guard
 * in `setWorktrees`. Compares only the fields the UI reads; `head` moves on
 * every commit inside a worktree and would defeat the guard without changing
 * anything a caller renders.
 */
function sameWorktrees(a: readonly GitWorktree[], b: readonly GitWorktree[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  return a.every((left, index) => {
    const right = b[index]
    return (
      right !== undefined &&
      left.path === right.path &&
      left.branch === right.branch &&
      left.locked === right.locked &&
      left.lockReason === right.lockReason &&
      left.prunable === right.prunable &&
      left.isMain === right.isMain
    )
  })
}

export interface GitState {
  // --- repo binding ---
  rootDir: string | null
  repoState: GitRepoState | null

  // --- status ---
  status: GitStatus | null
  loadingStatus: boolean
  loadError: string | null

  // --- selection ---
  selectedPath: string | null
  selectedStaged: boolean
  selectedCommit: string | null

  // --- diff cache (transient, LRU) ---
  diffCache: Record<string, GitDiff>
  diffCacheOrder: string[]

  // --- expanded groups (persisted) ---
  expandedGroups: Record<GitStatusGroup, boolean>

  // --- commit box ---
  commitDraft: Record<string, string> // rootDir -> message (persisted)
  commitAmend: boolean // transient — never carried across reloads

  // --- branch / stash / conflicts ---
  branches: GitBranch[]
  stashes: GitStashEntry[]
  conflicts: GitConflict[]
  activeConflictPath: string | null

  // --- worktrees / stacks ---
  /**
   * Every linked worktree of the bound repository, main checkout included.
   *
   * Backend-derived and deliberately NOT persisted: another process can prune
   * a worktree while the app is closed, so a restored list would be a claim
   * about the disk that nothing checked. The fs watcher keeps it fresh (it
   * learned to see `.git/worktrees/` for exactly this).
   */
  worktrees: GitWorktree[]
  /**
   * `[child, parent]` pairs from `branch.<name>.cognia-parent` (ADR-0151).
   * Git config is the record, so this is a cache of it, not a second truth.
   */
  stackParents: Array<[string, string]>

  // --- timeline ---
  timelineRepo: GitCommit[]
  timelineFile: GitCommit[]
  timelineScope: TimelineScope // persisted

  // --- ops / errors ---
  ops: Record<GitOp, boolean>
  lastError: { op: GitOp; message: string } | null

  // actions
  setRootDir: (rootDir: string | null) => void
  /**
   * A repository the user pinned the panel to, holding it against the
   * conversation-follow rule.
   *
   * Deliberately NOT persisted. Pinning is a comparison act — "what does this
   * look like on main" — and a pin that survived a restart would silently keep
   * the panel off the conversation days later, which is the exact confusion
   * following exists to remove. See `lib/workspace/panel-follow.ts`.
   */
  pinnedRoot: string | null
  setPinnedRoot: (rootDir: string | null) => void
  setRepoState: (state: GitRepoState | null) => void
  setStatus: (status: GitStatus | null) => void
  setLoadingStatus: (loading: boolean) => void
  setLoadError: (message: string | null) => void
  selectFile: (path: string | null, staged: boolean) => void
  selectCommit: (sha: string | null) => void
  cacheDiff: (key: string, diff: GitDiff) => void
  getCachedDiff: (key: string) => GitDiff | undefined
  invalidateDiff: (key: string) => void
  toggleGroup: (group: GitStatusGroup) => void
  setCommitDraft: (rootDir: string, message: string) => void
  setAmend: (amend: boolean) => void
  setBranches: (branches: GitBranch[]) => void
  setStashes: (stashes: GitStashEntry[]) => void
  setConflicts: (conflicts: GitConflict[]) => void
  setWorktrees: (worktrees: GitWorktree[]) => void
  setStackParents: (pairs: Array<[string, string]>) => void
  setActiveConflict: (path: string | null) => void
  setTimeline: (scope: TimelineScope, commits: GitCommit[]) => void
  setTimelineScope: (scope: TimelineScope) => void
  setOp: (op: GitOp, value: boolean) => void
  setError: (op: GitOp, message: string) => void
  clearError: () => void
  reset: () => void
}

export const useGitStore = create<GitState>()(
  persist(
    (set, get) => ({
      rootDir: null,
      pinnedRoot: null,
      repoState: null,
      status: null,
      loadingStatus: false,
      loadError: null,
      selectedPath: null,
      selectedStaged: false,
      selectedCommit: null,
      diffCache: {},
      diffCacheOrder: [],
      expandedGroups: { ...DEFAULT_EXPANDED },
      commitDraft: {},
      commitAmend: false,
      branches: [],
      stashes: [],
      conflicts: [],
      activeConflictPath: null,
      worktrees: [],
      stackParents: [],
      timelineRepo: [],
      timelineFile: [],
      timelineScope: "repo",
      ops: emptyOps(),
      lastError: null,

      setPinnedRoot: (pinnedRoot) => set({ pinnedRoot }),

      setRootDir: (rootDir) => {
        if (rootDir === get().rootDir) return
        // Switching repos clears all transient backend-derived state.
        set({
          rootDir,
          repoState: null,
          status: null,
          loadingStatus: false,
          loadError: null,
          selectedPath: null,
          selectedCommit: null,
          diffCache: {},
          diffCacheOrder: [],
          branches: [],
          stashes: [],
          conflicts: [],
          activeConflictPath: null,
          // Must clear with the branches they annotate: a worktree list held
          // across a repo switch would place the NEXT repository's branches
          // in the PREVIOUS one's directories.
          worktrees: [],
          stackParents: [],
          timelineRepo: [],
          timelineFile: [],
          commitAmend: false,
          lastError: null,
        })
      },

      setRepoState: (repoState) => set({ repoState }),
      setStatus: (status) => set({ status }),
      setLoadingStatus: (loadingStatus) => set({ loadingStatus }),
      setLoadError: (loadError) => set({ loadError }),

      selectFile: (path, staged) =>
        set({ selectedPath: path, selectedStaged: staged, selectedCommit: null }),

      selectCommit: (sha) => set({ selectedCommit: sha, selectedPath: null }),

      cacheDiff: (key, diff) =>
        set((s) => {
          const order = s.diffCacheOrder.filter((k) => k !== key)
          order.push(key)
          const cache = { ...s.diffCache, [key]: diff }
          while (order.length > GIT_BOUNDS.diffCacheMax) {
            const evicted = order.shift()
            if (evicted) delete cache[evicted]
          }
          return { diffCache: cache, diffCacheOrder: order }
        }),

      getCachedDiff: (key) => get().diffCache[key],

      invalidateDiff: (key) =>
        set((s) => {
          if (!(key in s.diffCache)) return s
          const cache = { ...s.diffCache }
          delete cache[key]
          return { diffCache: cache, diffCacheOrder: s.diffCacheOrder.filter((k) => k !== key) }
        }),

      toggleGroup: (group) =>
        set((s) => ({
          expandedGroups: { ...s.expandedGroups, [group]: !s.expandedGroups[group] },
        })),

      setCommitDraft: (rootDir, message) =>
        set((s) => ({ commitDraft: { ...s.commitDraft, [rootDir]: message } })),

      setAmend: (commitAmend) => set({ commitAmend }),
      setBranches: (branches) => set({ branches }),
      setStashes: (stashes) => set({ stashes }),
      setConflicts: (conflicts) => set({ conflicts }),
      // Identity-stable when nothing moved. Worktrees change orders of
      // magnitude less often than status, and the fs watcher republishes on
      // every relevant write, so without this guard each tick would hand
      // consumers a fresh array and re-run every `useMemo` keyed on it.
      setWorktrees: (worktrees) =>
        set((s) => (sameWorktrees(s.worktrees, worktrees) ? s : { worktrees })),
      setStackParents: (stackParents) => set({ stackParents }),
      setActiveConflict: (activeConflictPath) => set({ activeConflictPath }),

      setTimeline: (scope, commits) =>
        set(scope === "repo" ? { timelineRepo: commits } : { timelineFile: commits }),

      setTimelineScope: (timelineScope) => set({ timelineScope }),

      setOp: (op, value) => set((s) => ({ ops: { ...s.ops, [op]: value } })),

      setError: (op, message) => set({ lastError: { op, message } }),
      clearError: () => set({ lastError: null }),

      reset: () =>
        set({
          repoState: null,
          status: null,
          loadingStatus: false,
          loadError: null,
          selectedPath: null,
          selectedCommit: null,
          diffCache: {},
          diffCacheOrder: [],
          branches: [],
          stashes: [],
          conflicts: [],
          activeConflictPath: null,
          // Must clear with the branches they annotate: a worktree list held
          // across a repo switch would place the NEXT repository's branches
          // in the PREVIOUS one's directories.
          worktrees: [],
          stackParents: [],
          timelineRepo: [],
          timelineFile: [],
          ops: emptyOps(),
          lastError: null,
        }),
    }),
    {
      name: "cognia-git-ui",
      version: 1,
      storage: persistLocalStorage(),
      // Persist only durable UI shape; everything backend-derived is transient.
      partialize: (s) => ({
        expandedGroups: s.expandedGroups,
        commitDraft: s.commitDraft,
        timelineScope: s.timelineScope,
        selectedStaged: s.selectedStaged,
      }),
    }
  )
)

// ----------------------------------------------------------------- selectors

export const useGitRootDir = () => useGitStore((s) => s.rootDir)
export const useGitStatus = () => useGitStore((s) => s.status)
export const useGitConflicts = () => useGitStore((s) => s.conflicts)
export const useGitOp = (op: GitOp) => useGitStore((s) => s.ops[op])

/**
 * Branch + divergence shared by the panel header AND the StatusBar. Selects
 * primitives individually — returning a fresh object from a single selector
 * would break zustand v5's Object.is snapshot check and loop forever.
 */
export function useGitBranchInfo(): {
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
} {
  const branch = useGitStore((s) => s.status?.branch ?? null)
  const upstream = useGitStore((s) => s.status?.upstream ?? null)
  const ahead = useGitStore((s) => s.status?.ahead ?? 0)
  const behind = useGitStore((s) => s.status?.behind ?? 0)
  return { branch, upstream, ahead, behind }
}

/** True when any network/long op is running (for the StatusBar sync spinner). */
export function useGitBusy(): boolean {
  return useGitStore((s) => s.ops.sync || s.ops.push || s.ops.pull || s.ops.fetch)
}
