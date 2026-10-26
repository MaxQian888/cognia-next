/**
 * The plugin contract's share of `lib/plugin/api/git-api.ts`, which re-exports these.
 */
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
} from "../../../types/git/index"

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
