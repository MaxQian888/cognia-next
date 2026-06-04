/**
 * Typed wrappers around the Rust `git_*` Tauri commands. Mirrors the
 * `lib/perf/backend/commands.ts` seam: business code imports these named
 * functions, never `transport.call` directly. Every wrapper is gated by
 * `isTauri()` so the panel degrades to an inert desktop-only state on web.
 */

import { isTauri, transport } from "@/lib/tauri"
import { languageFromPath } from "./language-map"
import {
  EMPTY_REPO_STATE,
  EMPTY_STATUS,
  type AheadBehind,
  type ConflictSide,
  type GitBlameLine,
  type GitBranch,
  type GitCommit,
  type GitConflict,
  type GitDiff,
  type GitFileChange,
  type GitRef,
  type GitRemote,
  type GitRepoState,
  type GitResetMode,
  type GitStashEntry,
  type GitStatus,
  type GitTag,
  type RebaseTodoEntry,
} from "@/types/git"

// ----------------------------------------------------------------- reads

export async function gitIsRepo(repoPath: string): Promise<boolean> {
  if (!isTauri()) return false
  return transport.call<boolean>("git_is_repo", { repoPath })
}

export async function gitRepoState(repoPath: string): Promise<GitRepoState> {
  if (!isTauri()) return EMPTY_REPO_STATE
  return transport.call<GitRepoState>("git_repo_state", { repoPath })
}

export async function gitStatus(repoPath: string): Promise<GitStatus> {
  if (!isTauri()) return EMPTY_STATUS
  return transport.call<GitStatus>("git_status", { repoPath })
}

export async function gitDiffFile(
  repoPath: string,
  path: string,
  staged: boolean
): Promise<GitDiff> {
  if (!isTauri()) {
    return { path, oldContent: "", newContent: "", hunks: [], isBinary: false, language: null }
  }
  const diff = await transport.call<GitDiff>("git_diff_file", { repoPath, path, staged })
  return { ...diff, language: languageFromPath(diff.path) }
}

export async function gitDiffCommit(repoPath: string, sha: string, path: string): Promise<GitDiff> {
  if (!isTauri()) {
    return { path, oldContent: "", newContent: "", hunks: [], isBinary: false, language: null }
  }
  const diff = await transport.call<GitDiff>("git_diff_commit", { repoPath, sha, path })
  return { ...diff, language: languageFromPath(diff.path) }
}

export async function gitCommitFiles(repoPath: string, sha: string): Promise<GitFileChange[]> {
  if (!isTauri()) return []
  return transport.call<GitFileChange[]>("git_commit_files", { repoPath, sha })
}

/** Files changed between `base...target` (merge-base vs target). */
export async function gitDiffRefsFiles(
  repoPath: string,
  base: string,
  target: string
): Promise<GitFileChange[]> {
  if (!isTauri()) return []
  return transport.call<GitFileChange[]>("git_diff_refs_files", { repoPath, base, target })
}

/** Diff of one path between `base...target` (merge-base vs target). */
export async function gitDiffRefsFile(
  repoPath: string,
  base: string,
  target: string,
  path: string
): Promise<GitDiff> {
  if (!isTauri()) {
    return { path, oldContent: "", newContent: "", hunks: [], isBinary: false, language: null }
  }
  const diff = await transport.call<GitDiff>("git_diff_refs_file", {
    repoPath,
    base,
    target,
    path,
  })
  return { ...diff, language: languageFromPath(diff.path) }
}

/** Aggregate staged diff (`git diff --cached`) — input for AI commit messages. */
export async function gitDiffStagedAll(repoPath: string): Promise<string> {
  if (!isTauri()) return ""
  return transport.call<string>("git_diff_staged_all", { repoPath })
}

export async function gitLog(
  repoPath: string,
  maxCount: number,
  skip: number
): Promise<GitCommit[]> {
  if (!isTauri()) return []
  return transport.call<GitCommit[]>("git_log", { repoPath, maxCount, skip })
}

export async function gitFileHistory(
  repoPath: string,
  path: string,
  maxCount: number
): Promise<GitCommit[]> {
  if (!isTauri()) return []
  return transport.call<GitCommit[]>("git_file_history", { repoPath, path, maxCount })
}

export async function gitRefs(repoPath: string): Promise<GitRef[]> {
  if (!isTauri()) return []
  return transport.call<GitRef[]>("git_refs", { repoPath })
}

export async function gitBlame(
  repoPath: string,
  path: string,
  rev?: string
): Promise<GitBlameLine[]> {
  if (!isTauri()) return []
  return transport.call<GitBlameLine[]>("git_blame", { repoPath, path, rev: rev ?? null })
}

export async function gitBranches(repoPath: string): Promise<GitBranch[]> {
  if (!isTauri()) return []
  return transport.call<GitBranch[]>("git_branches", { repoPath })
}

export async function gitRemotes(repoPath: string): Promise<GitRemote[]> {
  if (!isTauri()) return []
  return transport.call<GitRemote[]>("git_remotes", { repoPath })
}

export async function gitTags(repoPath: string): Promise<GitTag[]> {
  if (!isTauri()) return []
  return transport.call<GitTag[]>("git_tags", { repoPath })
}

export async function gitStashList(repoPath: string): Promise<GitStashEntry[]> {
  if (!isTauri()) return []
  return transport.call<GitStashEntry[]>("git_stash_list", { repoPath })
}

export async function gitConflicts(repoPath: string): Promise<GitConflict[]> {
  if (!isTauri()) return []
  return transport.call<GitConflict[]>("git_conflicts", { repoPath })
}

// ----------------------------------------------- mutations / network

export async function gitStage(
  repoPath: string,
  paths: string[],
  hunkPatch?: string
): Promise<void> {
  if (!isTauri()) return
  await transport.call("git_stage", { repoPath, paths, hunkPatch: hunkPatch ?? null })
}

export async function gitUnstage(
  repoPath: string,
  paths: string[],
  hunkPatch?: string
): Promise<void> {
  if (!isTauri()) return
  await transport.call("git_unstage", { repoPath, paths, hunkPatch: hunkPatch ?? null })
}

export async function gitDiscard(
  repoPath: string,
  paths: string[],
  hunkPatch?: string
): Promise<void> {
  if (!isTauri()) return
  await transport.call("git_discard", { repoPath, paths, hunkPatch: hunkPatch ?? null })
}

export async function gitDiscardAll(repoPath: string, includeUntracked: boolean): Promise<void> {
  if (!isTauri()) return
  await transport.call("git_discard_all", { repoPath, includeUntracked })
}

export async function gitCommit(
  repoPath: string,
  message: string,
  amend: boolean,
  signoff: boolean
): Promise<string> {
  if (!isTauri()) return ""
  return transport.call<string>("git_commit", { repoPath, message, amend, signoff })
}

export async function gitCheckoutBranch(repoPath: string, name: string): Promise<void> {
  if (!isTauri()) return
  await transport.call("git_checkout_branch", { repoPath, name })
}

export async function gitCreateBranch(
  repoPath: string,
  name: string,
  checkout: boolean,
  from?: string
): Promise<void> {
  if (!isTauri()) return
  await transport.call("git_create_branch", { repoPath, name, checkout, from: from ?? null })
}

export async function gitDeleteBranch(
  repoPath: string,
  name: string,
  force: boolean
): Promise<void> {
  if (!isTauri()) return
  await transport.call("git_delete_branch", { repoPath, name, force })
}

export async function gitRenameBranch(
  repoPath: string,
  newName: string,
  old?: string
): Promise<void> {
  if (!isTauri()) return
  await transport.call("git_rename_branch", { repoPath, old: old ?? null, newName })
}

export async function gitFetch(repoPath: string, remote?: string, prune = false): Promise<void> {
  if (!isTauri()) return
  await transport.call("git_fetch", { repoPath, remote: remote ?? null, prune })
}

export async function gitPull(
  repoPath: string,
  options: { remote?: string; branch?: string; rebase?: boolean } = {}
): Promise<void> {
  if (!isTauri()) return
  await transport.call("git_pull", {
    repoPath,
    remote: options.remote ?? null,
    branch: options.branch ?? null,
    rebase: options.rebase ?? false,
  })
}

export async function gitPush(
  repoPath: string,
  options: {
    remote?: string
    branch?: string
    setUpstream?: boolean
    forceWithLease?: boolean
  } = {}
): Promise<void> {
  if (!isTauri()) return
  await transport.call("git_push", {
    repoPath,
    remote: options.remote ?? null,
    branch: options.branch ?? null,
    setUpstream: options.setUpstream ?? false,
    forceWithLease: options.forceWithLease ?? false,
  })
}

export async function gitSync(repoPath: string): Promise<AheadBehind> {
  if (!isTauri()) return { ahead: 0, behind: 0 }
  return transport.call<AheadBehind>("git_sync", { repoPath })
}

export async function gitRemoteAdd(repoPath: string, name: string, url: string): Promise<void> {
  if (!isTauri()) return
  await transport.call("git_remote_add", { repoPath, name, url })
}

export async function gitRemoteRemove(repoPath: string, name: string): Promise<void> {
  if (!isTauri()) return
  await transport.call("git_remote_remove", { repoPath, name })
}

export async function gitCreateTag(
  repoPath: string,
  name: string,
  message?: string,
  target?: string
): Promise<void> {
  if (!isTauri()) return
  await transport.call("git_create_tag", {
    repoPath,
    name,
    message: message ?? null,
    target: target ?? null,
  })
}

export async function gitDeleteTag(repoPath: string, name: string): Promise<void> {
  if (!isTauri()) return
  await transport.call("git_delete_tag", { repoPath, name })
}

export async function gitPushTag(repoPath: string, name: string, remote = "origin"): Promise<void> {
  if (!isTauri()) return
  await transport.call("git_push_tag", { repoPath, remote, name })
}

export async function gitReset(
  repoPath: string,
  mode: GitResetMode,
  target: string
): Promise<void> {
  if (!isTauri()) return
  await transport.call("git_reset", { repoPath, mode, target })
}

export async function gitRestore(
  repoPath: string,
  paths: string[],
  staged = false,
  source?: string
): Promise<void> {
  if (!isTauri()) return
  await transport.call("git_restore", { repoPath, paths, staged, source: source ?? null })
}

export async function gitStashPush(
  repoPath: string,
  options: { message?: string; includeUntracked?: boolean; keepIndex?: boolean } = {}
): Promise<void> {
  if (!isTauri()) return
  await transport.call("git_stash_push", {
    repoPath,
    message: options.message ?? null,
    includeUntracked: options.includeUntracked ?? false,
    keepIndex: options.keepIndex ?? false,
  })
}

export async function gitStashPop(repoPath: string, index: number): Promise<void> {
  if (!isTauri()) return
  await transport.call("git_stash_pop", { repoPath, index })
}

export async function gitStashApply(repoPath: string, index: number): Promise<void> {
  if (!isTauri()) return
  await transport.call("git_stash_apply", { repoPath, index })
}

export async function gitStashDrop(repoPath: string, index: number): Promise<void> {
  if (!isTauri()) return
  await transport.call("git_stash_drop", { repoPath, index })
}

export async function gitResolveConflict(
  repoPath: string,
  path: string,
  resolution: { mergedContent?: string; side?: ConflictSide }
): Promise<void> {
  if (!isTauri()) return
  await transport.call("git_resolve_conflict", {
    repoPath,
    path,
    mergedContent: resolution.mergedContent ?? null,
    side: resolution.side ?? null,
  })
}

/** `git init` — turn a plain directory into a repository. */
export async function gitInit(path: string): Promise<void> {
  if (!isTauri()) return
  await transport.call("git_init", { path })
}

/** Append a pattern to the repo-root `.gitignore` (no-op when already present). */
export async function gitIgnoreAdd(repoPath: string, pattern: string): Promise<void> {
  if (!isTauri()) return
  await transport.call("git_ignore_add", { repoPath, pattern })
}

export async function gitMerge(repoPath: string, branch: string): Promise<void> {
  if (!isTauri()) return
  await transport.call("git_merge", { repoPath, branch })
}

export async function gitMergeAbort(repoPath: string): Promise<void> {
  if (!isTauri()) return
  await transport.call("git_merge_abort", { repoPath })
}

export async function gitRebase(repoPath: string, onto: string): Promise<void> {
  if (!isTauri()) return
  await transport.call("git_rebase", { repoPath, onto })
}

export async function gitCherryPick(repoPath: string, sha: string): Promise<void> {
  if (!isTauri()) return
  await transport.call("git_cherry_pick", { repoPath, sha })
}

export async function gitRevert(repoPath: string, sha: string): Promise<void> {
  if (!isTauri()) return
  await transport.call("git_revert", { repoPath, sha })
}

export async function gitSequencerContinue(repoPath: string): Promise<void> {
  if (!isTauri()) return
  await transport.call("git_sequencer_continue", { repoPath })
}

export async function gitSequencerAbort(repoPath: string): Promise<void> {
  if (!isTauri()) return
  await transport.call("git_sequencer_abort", { repoPath })
}

/** Commits in `base..HEAD`, oldest first — the rows for the interactive rebase editor. */
export async function gitRebaseCommits(repoPath: string, base: string): Promise<GitCommit[]> {
  if (!isTauri()) return []
  return transport.call<GitCommit[]>("git_rebase_commits", { repoPath, base })
}

export async function gitInteractiveRebase(
  repoPath: string,
  base: string,
  entries: RebaseTodoEntry[]
): Promise<void> {
  if (!isTauri()) return
  await transport.call("git_interactive_rebase", { repoPath, base, entries })
}

export async function gitWatchStart(repoPath: string): Promise<void> {
  if (!isTauri()) return
  await transport.call("git_watch_start", { repoPath })
}

export async function gitWatchStop(repoPath: string): Promise<void> {
  if (!isTauri()) return
  await transport.call("git_watch_stop", { repoPath })
}
