/**
 * Plugin Git API — read/write access to the **active** source-control
 * repository for plugins (CI helpers, review bots, delivery automation).
 *
 * Design constraints:
 *  - Operates only on the repo currently bound in the Source Control panel
 *    (`useGitStore().rootDir`). Plugins never pass an arbitrary `repoPath`,
 *    so this cannot be used to escape the host's filesystem sandbox into
 *    some unrelated repo on disk.
 *  - Every method is a thin wrapper over the existing `lib/git/commands.ts`
 *    seam (the typed wrappers around the Rust `git_*` Tauri commands) — no
 *    reimplementation of git plumbing.
 *  - Reads are gated by `git:read`; mutations/network ops by `git:write`
 *    (a `DANGEROUS` permission — commit/push/discard can rewrite history or
 *    destroy working-tree changes).
 *
 * Desktop-only: the underlying commands return inert empties on web, but a
 * plugin should still gate its git features behind `ctx.capabilities.isTauri()`.
 */

import * as git from "@/lib/git/commands"
import { useGitStore } from "@/stores/git/git-store"
import { createGuardedAPI } from "@/lib/plugin/security/permission-guard"
import type {
  AheadBehind,
  ConflictSide,
  GitBranch,
  GitCommit,
  GitConflict,
  GitDiff,
  GitFileChange,
  GitRemote,
  GitRepoState,
  GitStashEntry,
  GitStatus,
} from "@/lib/git/types"

export interface PluginGitCommitOptions {
  amend?: boolean
  signoff?: boolean
}

export interface PluginGitCreateBranchOptions {
  /** Check out the new branch immediately. Default false. */
  checkout?: boolean
  /** Start point (commit-ish); defaults to current HEAD. */
  from?: string
}

export interface PluginGitPullOptions {
  remote?: string
  branch?: string
  rebase?: boolean
}

export interface PluginGitPushOptions {
  remote?: string
  branch?: string
  setUpstream?: boolean
  forceWithLease?: boolean
}

export interface PluginGitStashPushOptions {
  message?: string
  includeUntracked?: boolean
  keepIndex?: boolean
}

export interface PluginGitConflictResolution {
  mergedContent?: string
  side?: ConflictSide
}

/**
 * Git API exposed to plugins. All methods act on the active bound repo;
 * read methods need `git:read`, mutating methods need `git:write`.
 */
export interface PluginGitAPI {
  // --------------------------------------------------------------- reads
  /** Absolute path of the active bound repository, or `null` if none. */
  getRoot(): string | null
  /** Whether the active root is inside a git work-tree. */
  isRepo(): Promise<boolean>
  /** HEAD / branch / detached / operation-in-progress summary. */
  repoState(): Promise<GitRepoState>
  /** Working-tree status (staged / changes / merge groups). */
  status(): Promise<GitStatus>
  /** Commit log (newest first). */
  log(maxCount?: number, skip?: number): Promise<GitCommit[]>
  /** History for a single repo-relative path. */
  fileHistory(path: string, maxCount?: number): Promise<GitCommit[]>
  /** Unified diff for a working-tree file (staged or unstaged). */
  diffFile(path: string, staged?: boolean): Promise<GitDiff>
  /** Diff a single file as introduced by a commit. */
  diffCommit(sha: string, path: string): Promise<GitDiff>
  /** Files touched by a commit. */
  commitFiles(sha: string): Promise<GitFileChange[]>
  /** Local + remote branches. */
  branches(): Promise<GitBranch[]>
  /** Configured remotes. */
  remotes(): Promise<GitRemote[]>
  /** Stash entries. */
  stashList(): Promise<GitStashEntry[]>
  /** Unresolved merge conflicts. */
  conflicts(): Promise<GitConflict[]>
  /**
   * Subscribe to working-tree status changes (fires whenever the Source
   * Control store's `status` updates). Returns a disposer.
   */
  onStatusChange(handler: (status: GitStatus | null) => void): () => void

  // ----------------------------------------------------------- mutations
  /** Stage paths (optionally a single-hunk patch). */
  stage(paths: string[], hunkPatch?: string): Promise<void>
  /** Unstage paths (optionally a single-hunk patch). */
  unstage(paths: string[], hunkPatch?: string): Promise<void>
  /** Discard working-tree changes for paths (optionally a single hunk). */
  discard(paths: string[], hunkPatch?: string): Promise<void>
  /** Discard ALL working-tree changes; optionally also remove untracked. */
  discardAll(includeUntracked?: boolean): Promise<void>
  /** Commit the index. Returns the new commit SHA. */
  commit(message: string, options?: PluginGitCommitOptions): Promise<string>
  /** Check out an existing branch. */
  checkoutBranch(name: string): Promise<void>
  /** Create a branch (optionally checkout / from a start point). */
  createBranch(name: string, options?: PluginGitCreateBranchOptions): Promise<void>
  /** Delete a branch. */
  deleteBranch(name: string, force?: boolean): Promise<void>
  /** Rename a branch (defaults to the current branch when `old` omitted). */
  renameBranch(newName: string, old?: string): Promise<void>
  /** Fetch from a remote (optionally prune). */
  fetch(remote?: string, prune?: boolean): Promise<void>
  /** Pull (merge or rebase). */
  pull(options?: PluginGitPullOptions): Promise<void>
  /** Push (optionally set upstream / force-with-lease). */
  push(options?: PluginGitPushOptions): Promise<void>
  /** Fetch + report ahead/behind without changing the working tree. */
  sync(): Promise<AheadBehind>
  /** Create a stash. */
  stashPush(options?: PluginGitStashPushOptions): Promise<void>
  /** Pop a stash by index. */
  stashPop(index: number): Promise<void>
  /** Apply a stash by index without dropping it. */
  stashApply(index: number): Promise<void>
  /** Drop a stash by index. */
  stashDrop(index: number): Promise<void>
  /** Resolve a conflicted path (merged content or pick a side). */
  resolveConflict(path: string, resolution: PluginGitConflictResolution): Promise<void>
  /** Abort an in-progress merge. */
  mergeAbort(): Promise<void>
}

/** Thrown when a git method is called with no repository bound. */
export class NoActiveRepoError extends Error {
  constructor() {
    super(
      "ctx.git: no active repository — open a folder in the Source Control panel before calling git methods."
    )
    this.name = "NoActiveRepoError"
  }
}

function resolveRoot(): string {
  const root = useGitStore.getState().rootDir
  if (!root) throw new NoActiveRepoError()
  return root
}

/**
 * Create the Git API for a plugin. Methods are permission-gated via the
 * `PermissionGuard` proxy (`git:read` for reads, `git:write` for mutations).
 */
export function createGitAPI(pluginId: string): PluginGitAPI {
  const api: PluginGitAPI = {
    // reads
    getRoot: () => useGitStore.getState().rootDir,
    isRepo: () => git.gitIsRepo(resolveRoot()),
    repoState: () => git.gitRepoState(resolveRoot()),
    status: () => git.gitStatus(resolveRoot()),
    log: (maxCount = 50, skip = 0) => git.gitLog(resolveRoot(), maxCount, skip),
    fileHistory: (path, maxCount = 50) => git.gitFileHistory(resolveRoot(), path, maxCount),
    diffFile: (path, staged = false) => git.gitDiffFile(resolveRoot(), path, staged),
    diffCommit: (sha, path) => git.gitDiffCommit(resolveRoot(), sha, path),
    commitFiles: (sha) => git.gitCommitFiles(resolveRoot(), sha),
    branches: () => git.gitBranches(resolveRoot()),
    remotes: () => git.gitRemotes(resolveRoot()),
    stashList: () => git.gitStashList(resolveRoot()),
    conflicts: () => git.gitConflicts(resolveRoot()),
    onStatusChange: (handler) =>
      useGitStore.subscribe((state, prev) => {
        if (state.status !== prev.status) handler(state.status)
      }),

    // mutations
    stage: (paths, hunkPatch) => git.gitStage(resolveRoot(), paths, hunkPatch),
    unstage: (paths, hunkPatch) => git.gitUnstage(resolveRoot(), paths, hunkPatch),
    discard: (paths, hunkPatch) => git.gitDiscard(resolveRoot(), paths, hunkPatch),
    discardAll: (includeUntracked = false) => git.gitDiscardAll(resolveRoot(), includeUntracked),
    commit: (message, options) =>
      git.gitCommit(resolveRoot(), message, options?.amend ?? false, options?.signoff ?? false),
    checkoutBranch: (name) => git.gitCheckoutBranch(resolveRoot(), name),
    createBranch: (name, options) =>
      git.gitCreateBranch(resolveRoot(), name, options?.checkout ?? false, options?.from),
    deleteBranch: (name, force = false) => git.gitDeleteBranch(resolveRoot(), name, force),
    renameBranch: (newName, old) => git.gitRenameBranch(resolveRoot(), newName, old),
    fetch: (remote, prune = false) => git.gitFetch(resolveRoot(), remote, prune),
    pull: (options) => git.gitPull(resolveRoot(), options ?? {}),
    push: (options) => git.gitPush(resolveRoot(), options ?? {}),
    sync: () => git.gitSync(resolveRoot()),
    stashPush: (options) => git.gitStashPush(resolveRoot(), options ?? {}),
    stashPop: (index) => git.gitStashPop(resolveRoot(), index),
    stashApply: (index) => git.gitStashApply(resolveRoot(), index),
    stashDrop: (index) => git.gitStashDrop(resolveRoot(), index),
    resolveConflict: (path, resolution) => git.gitResolveConflict(resolveRoot(), path, resolution),
    mergeAbort: () => git.gitMergeAbort(resolveRoot()),
  }

  return createGuardedAPI(pluginId, api, {
    getRoot: "git:read",
    isRepo: "git:read",
    repoState: "git:read",
    status: "git:read",
    log: "git:read",
    fileHistory: "git:read",
    diffFile: "git:read",
    diffCommit: "git:read",
    commitFiles: "git:read",
    branches: "git:read",
    remotes: "git:read",
    stashList: "git:read",
    conflicts: "git:read",
    onStatusChange: "git:read",
    stage: "git:write",
    unstage: "git:write",
    discard: "git:write",
    discardAll: "git:write",
    commit: "git:write",
    checkoutBranch: "git:write",
    createBranch: "git:write",
    deleteBranch: "git:write",
    renameBranch: "git:write",
    fetch: "git:write",
    pull: "git:write",
    push: "git:write",
    sync: "git:write",
    stashPush: "git:write",
    stashPop: "git:write",
    stashApply: "git:write",
    stashDrop: "git:write",
    resolveConflict: "git:write",
    mergeAbort: "git:write",
  })
}
