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
import { createJSONStorage, persist } from "zustand/middleware"
import type {
  GitBranch,
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
  | "checkout"
  | "stash"
  | "discard"
  | "resolve"
  | "branch"
  | "remote"
  | "tag"
  | "reset"

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
    checkout: false,
    stash: false,
    discard: false,
    resolve: false,
    branch: false,
    remote: false,
    tag: false,
    reset: false,
  }
}

export interface GitState {
  // --- repo binding ---
  rootDir: string | null
  repoState: GitRepoState | null

  // --- status ---
  status: GitStatus | null
  loadingStatus: boolean

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

  // --- timeline ---
  timelineRepo: GitCommit[]
  timelineFile: GitCommit[]
  timelineScope: TimelineScope // persisted

  // --- ops / errors ---
  ops: Record<GitOp, boolean>
  lastError: { op: GitOp; message: string } | null

  // actions
  setRootDir: (rootDir: string | null) => void
  setRepoState: (state: GitRepoState | null) => void
  setStatus: (status: GitStatus | null) => void
  setLoadingStatus: (loading: boolean) => void
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
      repoState: null,
      status: null,
      loadingStatus: false,
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
      timelineRepo: [],
      timelineFile: [],
      timelineScope: "repo",
      ops: emptyOps(),
      lastError: null,

      setRootDir: (rootDir) => {
        if (rootDir === get().rootDir) return
        // Switching repos clears all transient backend-derived state.
        set({
          rootDir,
          repoState: null,
          status: null,
          selectedPath: null,
          selectedCommit: null,
          diffCache: {},
          diffCacheOrder: [],
          branches: [],
          stashes: [],
          conflicts: [],
          activeConflictPath: null,
          timelineRepo: [],
          timelineFile: [],
          commitAmend: false,
          lastError: null,
        })
      },

      setRepoState: (repoState) => set({ repoState }),
      setStatus: (status) => set({ status }),
      setLoadingStatus: (loadingStatus) => set({ loadingStatus }),

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
          selectedPath: null,
          selectedCommit: null,
          diffCache: {},
          diffCacheOrder: [],
          branches: [],
          stashes: [],
          conflicts: [],
          activeConflictPath: null,
          timelineRepo: [],
          timelineFile: [],
          ops: emptyOps(),
          lastError: null,
        }),
    }),
    {
      name: "cognia-git-ui",
      version: 1,
      storage: createJSONStorage(() => localStorage),
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
