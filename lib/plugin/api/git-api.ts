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
import type { PluginGitAPI } from "@cognia/plugin-contract/lib/plugin/api/git-api"
export type {
  PluginGitAPI,
  PluginGitCommitOptions,
  PluginGitConflictResolution,
  PluginGitCreateBranchOptions,
  PluginGitPullOptions,
  PluginGitPushOptions,
  PluginGitStashPushOptions,
} from "@cognia/plugin-contract/lib/plugin/api/git-api"

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
