/**
 * Typed wrappers around the Rust `git_*` commands. Mirrors the
 * `lib/perf/backend/commands.ts` seam: business code imports these named
 * functions, never `transport.call` directly.
 *
 * Every wrapper is gated by {@link hasGitBridge} — true on Tauri desktop
 * (invoke) AND on the Capacitor / web-companion transports, where the same
 * camelCase payloads ride `/api/_rpc/git_*` (companion writes additionally
 * need the device's remote-control capability — the server answers 403
 * otherwise). Only on a plain unpaired browser do the wrappers degrade to
 * inert empty results. Exception: `gitWatchStart` / `gitWatchStop` stay
 * Tauri-only — the fs watcher lives in Tauri managed state; remote clients
 * get the forwarded `git://status-changed` WS event instead (see events.ts).
 */

import { isCapacitor, isTauri } from "@/lib/platform/detect"
import { hasWebCompanionTarget } from "@/lib/platform/web-companion"
import { transport as baseTransport } from "@/lib/tauri"
import { issueHostAdminLease } from "@/lib/tauri/admin-lease"
import { getCommandDescriptor } from "@/lib/tauri/command-descriptors"
import { getRuntimeSnapshot } from "@/lib/runtime/runtime-snapshot-store"
import { resolveOperationAvailability } from "@/lib/runtime/operation-availability"
import { languageFromPath } from "./language-map"
import { gitTargetArgs, gitTargetFromRemote, isRemoteGitTarget, parseGitTarget } from "./target"
import {
  EMPTY_REPO_STATE,
  EMPTY_STATUS,
  type AheadBehind,
  type ConflictSide,
  type GitBlameLine,
  type GitBranch,
  type GitCommit,
  type GitConflict,
  type GitDefaultBranch,
  type GitDiff,
  type GitFileChange,
  type GitFileDiffStat,
  type GitIdentity,
  type GitRef,
  type GitRemote,
  type GitRepoState,
  type GitResetMode,
  type GitRestackOutcome,
  type GitStackCapabilities,
  type GitStackLayerState,
  type GitStackPushOutcome,
  type GitStashEntry,
  type GitStatus,
  type GitTag,
  type GitWorktree,
  type RebaseTodoEntry,
} from "@/types/git"

export interface RemoteGitWorkspace {
  workspaceId: string
  displayName: string
  repositoryState: GitRepoState
}

interface PendingGitApproval {
  command: string
  token: string
}

const pendingGitApprovals: PendingGitApproval[] = []

function prepareGitTransportArgs(command: string, rawArgs: unknown): Record<string, unknown> {
  const args = { ...((rawArgs ?? {}) as Record<string, unknown>) }
  const repoPath = typeof args.repoPath === "string" ? args.repoPath : null
  if (!isTauri() && repoPath && !isRemoteGitTarget(repoPath)) {
    throw new Error("Remote Git requests require an opaque workspace target")
  }
  if (repoPath && isRemoteGitTarget(repoPath)) {
    Object.assign(args, gitTargetArgs(repoPath))
    delete args.repoPath
    if (command === "git_worktree_add" && typeof args.path === "string") {
      args.destinationRelativePath = args.path
      delete args.path
    }
    if (command === "git_worktree_remove" && typeof args.path === "string") {
      args.worktreeRelativePath = args.path
      delete args.path
    }
  }
  if (command === "git_worktree_commit" && typeof args.worktreePath === "string") {
    const worktreePath = args.worktreePath
    if (isRemoteGitTarget(worktreePath)) {
      const target = parseGitTarget(worktreePath)
      if (target.kind === "remote") {
        args.workspaceId = target.workspaceId
        args.worktreeRelativePath = target.relativePath
        delete args.worktreePath
      }
    } else if (!isTauri()) {
      throw new Error("Remote Git requests require an opaque workspace target")
    }
  }
  if (command === "git_init" && typeof args.path === "string" && isRemoteGitTarget(args.path)) {
    Object.assign(args, gitTargetArgs(args.path))
    delete args.path
  } else if (command === "git_init" && typeof args.path === "string" && !isTauri()) {
    throw new Error("Remote Git requests require an opaque workspace target")
  }
  if (
    command === "git_clone" &&
    typeof args.destination === "string" &&
    isRemoteGitTarget(args.destination)
  ) {
    const target = parseGitTarget(args.destination)
    if (target.kind === "remote") {
      args.workspaceId = target.workspaceId
      args.destinationRelativePath = target.relativePath
      delete args.destination
    }
  } else if (command === "git_clone" && typeof args.destination === "string" && !isTauri()) {
    throw new Error("Remote Git requests require an opaque workspace target")
  }
  const descriptor = getCommandDescriptor(command)
  if (
    descriptor?.approval === "interactive" &&
    Object.values(args).some((value) => typeof value === "string" && isRemoteGitTarget(value))
  ) {
    throw new Error(`Remote Git target for ${command} was not normalized`)
  }
  const pendingIndex = pendingGitApprovals.findIndex((approval) => approval.command === command)
  if (pendingIndex >= 0) {
    const [approval] = pendingGitApprovals.splice(pendingIndex, 1)
    args.adminLease = approval.token
  }
  return args
}

const transport = {
  call<T>(command: string, args?: unknown): Promise<T> {
    return baseTransport.call<T>(command, prepareGitTransportArgs(command, args))
  },
}

export function getGitOperationAvailability(
  command: string
): ReturnType<typeof resolveOperationAvailability> {
  return resolveGitOperationAvailability(getRuntimeSnapshot(), command)
}

export function resolveGitOperationAvailability(
  snapshot: ReturnType<typeof getRuntimeSnapshot>,
  command: string
): ReturnType<typeof resolveOperationAvailability> {
  const availability = resolveOperationAvailability({ snapshot, command })
  if (availability.state !== "available") return availability
  const descriptor = getCommandDescriptor(command)
  if (
    snapshot.target?.kind === "companion" &&
    descriptor?.approval === "interactive" &&
    (!snapshot.host?.operations.includes("host_admin_lease_issue") ||
      !snapshot.host.grants.includes("host.admin"))
  ) {
    return {
      state: "requires-grant",
      reason: "missing-grant",
      requiredGrant: "host.admin",
    }
  }
  return availability
}

/** Bind one exact 120-second approval lease to a user-triggered Git mutation. */
export async function runGitUserAction<T>(
  command: string,
  operation: () => Promise<T>
): Promise<T> {
  if (isTauri()) return operation()
  const availability = getGitOperationAvailability(command)
  if (availability.state !== "available") {
    throw new Error(`Git operation unavailable: ${availability.reason}`)
  }
  const lease = await issueHostAdminLease([command], 120)
  const approval = { command, token: lease.token }
  pendingGitApprovals.push(approval)
  try {
    return await operation()
  } finally {
    const index = pendingGitApprovals.indexOf(approval)
    if (index >= 0) pendingGitApprovals.splice(index, 1)
  }
}

/**
 * Whether a transport that can actually reach the native git backend is
 * active: Tauri desktop, the Capacitor mobile shell, or a web client paired
 * with a cognia server. This is the *seam capability* gate — every command
 * wrapper below short-circuits on it. It is NOT the UI-availability gate:
 * whether the Source Control *panel* is offered is a separate, narrower
 * decision (see {@link isSourceControlUiAvailable}).
 */
export function hasGitBridge(): boolean {
  return isTauri() || isCapacitor() || hasWebCompanionTarget()
}

/**
 * Whether the Source Control *UI* — the panel and the StatusBar branch chip —
 * should be offered. Deliberately narrower than {@link hasGitBridge}: the panel
 * is desktop-only for now. The seam can already reach git over Capacitor and a
 * web-companion, but surfacing the panel there needs repo-binding, fs-watcher,
 * and open-folder semantics redefined for a repo-less mobile shell and a remote
 * host — tracked as an ADR-0038 follow-up. Both the panel (`useGitRepo`) and
 * the chip (`useGitBranchIndicator`) gate on THIS single helper so a live chip
 * can never navigate to a dead panel.
 */
export function isSourceControlUiAvailable(): boolean {
  if (isTauri()) return true
  const snapshot = getRuntimeSnapshot()
  return (
    snapshot.target?.kind === "companion" &&
    resolveGitOperationAvailability(snapshot, "git_workspace_list").state === "available"
  )
}

// ----------------------------------------------------------------- reads

export async function gitWorkspaceList(): Promise<RemoteGitWorkspace[]> {
  if (!hasGitBridge() || isTauri()) return []
  return transport.call<RemoteGitWorkspace[]>("git_workspace_list", {})
}

export async function gitIsRepo(repoPath: string): Promise<boolean> {
  if (!hasGitBridge()) return false
  return transport.call<boolean>("git_is_repo", { repoPath })
}

export async function gitRepoState(repoPath: string): Promise<GitRepoState> {
  if (!hasGitBridge()) return EMPTY_REPO_STATE
  const state = await transport.call<GitRepoState>("git_repo_state", { repoPath })
  const target = parseGitTarget(repoPath)
  if (target.kind !== "remote" || !state.rootDir) return state
  return {
    ...state,
    rootDir: gitTargetFromRemote(target.workspaceId, state.rootDir),
  }
}

export async function gitStatus(repoPath: string): Promise<GitStatus> {
  if (!hasGitBridge()) return EMPTY_STATUS
  return transport.call<GitStatus>("git_status", { repoPath })
}

export async function gitDiffStat(repoPath: string): Promise<GitFileDiffStat[]> {
  if (!hasGitBridge()) return []
  return transport.call<GitFileDiffStat[]>("git_diff_stat", { repoPath })
}

export async function gitDiffFile(
  repoPath: string,
  path: string,
  staged: boolean
): Promise<GitDiff> {
  if (!hasGitBridge()) {
    return { path, oldContent: "", newContent: "", hunks: [], isBinary: false, language: null }
  }
  const diff = await transport.call<GitDiff>("git_diff_file", { repoPath, path, staged })
  return { ...diff, language: languageFromPath(diff.path) }
}

export async function gitDiffCommit(repoPath: string, sha: string, path: string): Promise<GitDiff> {
  if (!hasGitBridge()) {
    return { path, oldContent: "", newContent: "", hunks: [], isBinary: false, language: null }
  }
  const diff = await transport.call<GitDiff>("git_diff_commit", { repoPath, sha, path })
  return { ...diff, language: languageFromPath(diff.path) }
}

export async function gitCommitFiles(repoPath: string, sha: string): Promise<GitFileChange[]> {
  if (!hasGitBridge()) return []
  return transport.call<GitFileChange[]>("git_commit_files", { repoPath, sha })
}

/** Files changed between `base...target` (merge-base vs target). */
export async function gitDiffRefsFiles(
  repoPath: string,
  base: string,
  target: string
): Promise<GitFileChange[]> {
  if (!hasGitBridge()) return []
  return transport.call<GitFileChange[]>("git_diff_refs_files", { repoPath, base, target })
}

/** Diff of one path between `base...target` (merge-base vs target). */
export async function gitDiffRefsFile(
  repoPath: string,
  base: string,
  target: string,
  path: string
): Promise<GitDiff> {
  if (!hasGitBridge()) {
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
  if (!hasGitBridge()) return ""
  return transport.call<string>("git_diff_staged_all", { repoPath })
}

export async function gitLog(
  repoPath: string,
  maxCount: number,
  skip: number
): Promise<GitCommit[]> {
  if (!hasGitBridge()) return []
  return transport.call<GitCommit[]>("git_log", { repoPath, maxCount, skip })
}

export async function gitFileHistory(
  repoPath: string,
  path: string,
  maxCount: number
): Promise<GitCommit[]> {
  if (!hasGitBridge()) return []
  return transport.call<GitCommit[]>("git_file_history", { repoPath, path, maxCount })
}

export async function gitRefs(repoPath: string): Promise<GitRef[]> {
  if (!hasGitBridge()) return []
  return transport.call<GitRef[]>("git_refs", { repoPath })
}

export async function gitBlame(
  repoPath: string,
  path: string,
  rev?: string
): Promise<GitBlameLine[]> {
  if (!hasGitBridge()) return []
  return transport.call<GitBlameLine[]>("git_blame", { repoPath, path, rev: rev ?? null })
}

export async function gitBranches(repoPath: string): Promise<GitBranch[]> {
  if (!hasGitBridge()) return []
  return transport.call<GitBranch[]>("git_branches", { repoPath })
}

/**
 * The repository's trunk, resolved from local refs alone.
 *
 * Reads inert without a bridge — but there is no honest inert answer here, so
 * it reports a `guess` that says `exists: false` rather than a confident
 * `"main"` a caller would then base a pull request on.
 */
export async function gitDefaultBranch(
  repoPath: string,
  remote?: string
): Promise<GitDefaultBranch> {
  if (!hasGitBridge()) return { branch: "main", source: "guess", exists: false }
  return transport.call<GitDefaultBranch>("git_default_branch", {
    repoPath,
    ...(remote ? { remote } : {}),
  })
}

export async function gitRemotes(repoPath: string): Promise<GitRemote[]> {
  if (!hasGitBridge()) return []
  return transport.call<GitRemote[]>("git_remotes", { repoPath })
}

export async function gitTags(repoPath: string): Promise<GitTag[]> {
  if (!hasGitBridge()) return []
  return transport.call<GitTag[]>("git_tags", { repoPath })
}

export async function gitStashList(repoPath: string): Promise<GitStashEntry[]> {
  if (!hasGitBridge()) return []
  return transport.call<GitStashEntry[]>("git_stash_list", { repoPath })
}

export async function gitConflicts(repoPath: string): Promise<GitConflict[]> {
  if (!hasGitBridge()) return []
  return transport.call<GitConflict[]>("git_conflicts", { repoPath })
}

// ----------------------------------------------- mutations / network

export async function gitStage(
  repoPath: string,
  paths: string[],
  hunkPatch?: string
): Promise<void> {
  if (!hasGitBridge()) return
  await transport.call("git_stage", { repoPath, paths, hunkPatch: hunkPatch ?? null })
}

export async function gitUnstage(
  repoPath: string,
  paths: string[],
  hunkPatch?: string
): Promise<void> {
  if (!hasGitBridge()) return
  await transport.call("git_unstage", { repoPath, paths, hunkPatch: hunkPatch ?? null })
}

export async function gitDiscard(
  repoPath: string,
  paths: string[],
  hunkPatch?: string
): Promise<void> {
  if (!hasGitBridge()) return
  await transport.call("git_discard", { repoPath, paths, hunkPatch: hunkPatch ?? null })
}

export async function gitDiscardAll(repoPath: string, includeUntracked: boolean): Promise<void> {
  if (!hasGitBridge()) return
  await transport.call("git_discard_all", { repoPath, includeUntracked })
}

export async function gitCommit(
  repoPath: string,
  message: string,
  amend: boolean,
  signoff: boolean
): Promise<string> {
  if (!hasGitBridge()) return ""
  return transport.call<string>("git_commit", { repoPath, message, amend, signoff })
}

export async function gitCheckoutBranch(repoPath: string, name: string): Promise<void> {
  if (!hasGitBridge()) return
  await transport.call("git_checkout_branch", { repoPath, name })
}

export async function gitCreateBranch(
  repoPath: string,
  name: string,
  checkout: boolean,
  from?: string
): Promise<void> {
  if (!hasGitBridge()) return
  await transport.call("git_create_branch", { repoPath, name, checkout, from: from ?? null })
}

export async function gitDeleteBranch(
  repoPath: string,
  name: string,
  force: boolean
): Promise<void> {
  if (!hasGitBridge()) return
  await transport.call("git_delete_branch", { repoPath, name, force })
}

export async function gitRenameBranch(
  repoPath: string,
  newName: string,
  old?: string
): Promise<void> {
  if (!hasGitBridge()) return
  await transport.call("git_rename_branch", { repoPath, old: old ?? null, newName })
}

// --------------------------------------------------- worktrees (agent isolation)

/**
 * `git worktree add -b <branch> <path> [<baseRef>]`. Creates a linked worktree
 * on a fresh branch; rejects (throws) if the branch already exists / is checked
 * out elsewhere — the agent allocator relies on that as a collision guard.
 */
export async function gitWorktreeAdd(
  repoPath: string,
  path: string,
  branch: string,
  baseRef?: string,
  hookContext?: WorktreeHookContext
): Promise<void> {
  if (!hasGitBridge()) return
  await transport.call("git_worktree_add", { repoPath, path, branch, baseRef: baseRef ?? null })
  await fireWorktreeHook(
    "WorktreeCreate",
    repoPath,
    {
      worktree_path: path,
      workspace_root: repoPath,
      branch,
      base_ref: baseRef ?? null,
      source: hookContext?.source ?? "git-command",
      ...(hookContext?.ownerType ? { owner_type: hookContext.ownerType } : {}),
      ...(hookContext?.ownerRef ? { owner_ref: hookContext.ownerRef } : {}),
    },
    hookContext
  )
}

/** `git worktree remove [--force] <path>`, optionally deleting the branch. */
export async function gitWorktreeRemove(
  repoPath: string,
  path: string,
  force: boolean,
  deleteBranch?: string,
  hookContext?: WorktreeHookContext
): Promise<void> {
  if (!hasGitBridge()) return
  await transport.call("git_worktree_remove", {
    repoPath,
    path,
    force,
    deleteBranch: deleteBranch ?? null,
  })
  await fireWorktreeHook(
    "WorktreeRemove",
    repoPath,
    {
      worktree_path: path,
      workspace_root: repoPath,
      branch: deleteBranch ?? null,
      force,
      reason: hookContext?.reason ?? "remove",
      source: hookContext?.source ?? "git-command",
      ...(hookContext?.ownerType ? { owner_type: hookContext.ownerType } : {}),
      ...(hookContext?.ownerRef ? { owner_ref: hookContext.ownerRef } : {}),
    },
    hookContext
  )
}

/**
 * Who is creating/removing the worktree, for the `WorktreeCreate` /
 * `WorktreeRemove` hook payload. Optional: the source-control panel passes
 * its user-driven ownership metadata. Managed callers go through the Registry
 * lifecycle sink instead of this manual Git seam.
 */
export interface WorktreeHookContext {
  sessionId?: string
  /** `worktree-panel` | another manual Git caller; defaults to `git-command`. */
  source?: string
  ownerType?: string
  ownerRef?: string
  /** Removal reason (`cleanup`, `prune`, `user`) — `WorktreeRemove` only. */
  reason?: string
}

/**
 * The TS producer for the two worktree hook events (ADR-0111 decision 9).
 * The managed Registry fires them from Rust; manual source-control operations
 * funnel through `gitWorktreeAdd` / `gitWorktreeRemove` above.
 * Payload field names match the Rust producer (`worktree_hook_fields`).
 * Observational: never throws, never blocks the git operation that succeeded.
 */
async function fireWorktreeHook(
  event: "WorktreeCreate" | "WorktreeRemove",
  cwd: string,
  payload: Record<string, unknown>,
  hookContext?: WorktreeHookContext
): Promise<void> {
  if (!isTauri()) return
  try {
    const { fireAgentHook } = await import("@/lib/ai/agent/external/agent-hooks")
    await fireAgentHook(
      event,
      {
        agentId: hookContext?.source ?? "git-command",
        // Worktree lifecycle is host bookkeeping, not an agent turn.
        agentKind: "system",
        sessionId: hookContext?.sessionId ?? "",
        cwd,
      },
      { payload }
    )
  } catch {
    // Observational hook; a failure to reach the runner is not a git failure.
  }
}

/** `git worktree list --porcelain`, parsed. Empty on web (no git backend). */
export async function gitWorktreeList(repoPath: string): Promise<GitWorktree[]> {
  if (!hasGitBridge()) return []
  return transport.call<GitWorktree[]>("git_worktree_list", { repoPath })
}

/**
 * Stage all + commit inside a worktree so the agent's work lands on its branch.
 * Returns the new commit SHA, or `null` when the tree was already clean.
 */
export async function gitWorktreeCommit(
  worktreePath: string,
  message: string
): Promise<string | null> {
  if (!hasGitBridge()) return null
  return transport.call<string | null>("git_worktree_commit", { worktreePath, message })
}

/**
 * `git worktree prune` — drop administrative entries for worktrees whose
 * directories were removed out-of-band (crash/GC recovery). Reclaims the
 * `.git/worktrees/<id>` bookkeeping so a later branch delete isn't blocked by a
 * "checked out in a worktree" ref that no longer has a working tree. No-op on
 * web (no git backend).
 */
export async function gitWorktreePrune(repoPath: string): Promise<void> {
  if (!hasGitBridge()) return
  await transport.call("git_worktree_prune", { repoPath })
}

export async function gitFetch(repoPath: string, remote?: string, prune = false): Promise<void> {
  if (!hasGitBridge()) return
  await transport.call("git_fetch", { repoPath, remote: remote ?? null, prune })
}

export async function gitPull(
  repoPath: string,
  options: { remote?: string; branch?: string; rebase?: boolean } = {}
): Promise<void> {
  if (!hasGitBridge()) return
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
  if (!hasGitBridge()) return
  await transport.call("git_push", {
    repoPath,
    remote: options.remote ?? null,
    branch: options.branch ?? null,
    setUpstream: options.setUpstream ?? false,
    forceWithLease: options.forceWithLease ?? false,
  })
}

export async function gitSync(repoPath: string): Promise<AheadBehind> {
  if (!hasGitBridge()) return { ahead: 0, behind: 0 }
  return transport.call<AheadBehind>("git_sync", { repoPath })
}

export async function gitRemoteAdd(repoPath: string, name: string, url: string): Promise<void> {
  if (!hasGitBridge()) return
  await transport.call("git_remote_add", { repoPath, name, url })
}

export async function gitRemoteRemove(repoPath: string, name: string): Promise<void> {
  if (!hasGitBridge()) return
  await transport.call("git_remote_remove", { repoPath, name })
}

export async function gitCreateTag(
  repoPath: string,
  name: string,
  message?: string,
  target?: string
): Promise<void> {
  if (!hasGitBridge()) return
  await transport.call("git_create_tag", {
    repoPath,
    name,
    message: message ?? null,
    target: target ?? null,
  })
}

export async function gitDeleteTag(repoPath: string, name: string): Promise<void> {
  if (!hasGitBridge()) return
  await transport.call("git_delete_tag", { repoPath, name })
}

export async function gitPushTag(repoPath: string, name: string, remote = "origin"): Promise<void> {
  if (!hasGitBridge()) return
  await transport.call("git_push_tag", { repoPath, remote, name })
}

export async function gitReset(
  repoPath: string,
  mode: GitResetMode,
  target: string
): Promise<void> {
  if (!hasGitBridge()) return
  await transport.call("git_reset", { repoPath, mode, target })
}

export async function gitRestore(
  repoPath: string,
  paths: string[],
  staged = false,
  source?: string
): Promise<void> {
  if (!hasGitBridge()) return
  await transport.call("git_restore", { repoPath, paths, staged, source: source ?? null })
}

export async function gitStashPush(
  repoPath: string,
  options: { message?: string; includeUntracked?: boolean; keepIndex?: boolean } = {}
): Promise<void> {
  if (!hasGitBridge()) return
  await transport.call("git_stash_push", {
    repoPath,
    message: options.message ?? null,
    includeUntracked: options.includeUntracked ?? false,
    keepIndex: options.keepIndex ?? false,
  })
}

export async function gitStashPop(repoPath: string, index: number): Promise<void> {
  if (!hasGitBridge()) return
  await transport.call("git_stash_pop", { repoPath, index })
}

export async function gitStashApply(repoPath: string, index: number): Promise<void> {
  if (!hasGitBridge()) return
  await transport.call("git_stash_apply", { repoPath, index })
}

export async function gitStashDrop(repoPath: string, index: number): Promise<void> {
  if (!hasGitBridge()) return
  await transport.call("git_stash_drop", { repoPath, index })
}

export async function gitResolveConflict(
  repoPath: string,
  path: string,
  resolution: { mergedContent?: string; side?: ConflictSide }
): Promise<void> {
  if (!hasGitBridge()) return
  await transport.call("git_resolve_conflict", {
    repoPath,
    path,
    mergedContent: resolution.mergedContent ?? null,
    side: resolution.side ?? null,
  })
}

/** `git init` — turn a plain directory into a repository. */
export async function gitInit(path: string): Promise<void> {
  if (!hasGitBridge()) return
  await transport.call("git_init", { path })
}

/** Clone a remote repository and return the canonical cloned worktree path. */
/** Guard rails for {@link gitCloneGuarded}. Every field has a host default. */
export interface GitCloneGuards {
  /** Hosts beyond github.com / gitlab.com / bitbucket.org. */
  allowedHosts?: string[]
  /**
   * `--depth`. 0 clones full history, which is the default.
   *
   * Opt-in rather than the default it used to be: a shallow clone cannot be
   * rebased past its boundary, `git log` shows one commit, and `merge-base`
   * cannot answer — while the same checkout is handed to callers that ask for
   * exactly those. The host clones `--filter=blob:none` instead.
   */
  depth?: number
  /** Reject (and delete) a checkout above this size. Default 500. */
  maxSizeMb?: number
  /** Wall-clock budget. Default 120. */
  timeoutSecs?: number
}

/**
 * Clone under guard rails — https only, host allow-list, no embedded
 * credentials, shallow, timed, size bounded.
 *
 * For callers that did not type the URL themselves (a plugin acquiring a
 * repository to document). {@link gitClone} stays unguarded for the Source
 * Control panel, where the user supplied the remote.
 */
export async function gitCloneGuarded(
  remoteUrl: string,
  destination: string,
  guards?: GitCloneGuards
): Promise<string> {
  if (!hasGitBridge()) return ""
  return transport.call<string>("git_clone_guarded", { remoteUrl, destination, guards })
}

/**
 * Read a file as text at a revision. `null` means absent-at-that-ref or binary
 * — an ordinary answer when diffing two revisions; an unresolvable ref throws.
 */
export async function gitReadBlobAtRef(
  repoPath: string,
  gitRef: string,
  path: string
): Promise<string | null> {
  if (!hasGitBridge()) return null
  return transport.call<string | null>("git_read_blob_at_ref", { repoPath, gitRef, path })
}

export async function gitClone(remoteUrl: string, destination: string): Promise<string> {
  if (!hasGitBridge()) return ""
  const cloned = await transport.call<string | { workspaceId: string; relativePath: string }>(
    "git_clone",
    { remoteUrl, destination }
  )
  return typeof cloned === "string"
    ? cloned
    : gitTargetFromRemote(cloned.workspaceId, cloned.relativePath)
}

/** Resolve the repository's effective local/global commit identity. */
export async function gitIdentity(repoPath: string): Promise<GitIdentity> {
  if (!hasGitBridge()) return { name: null, email: null }
  return transport.call<GitIdentity>("git_identity", { repoPath })
}

/** Set repository-local or user-global commit identity. */
export async function gitSetIdentity(
  repoPath: string,
  name: string,
  email: string,
  global: boolean
): Promise<void> {
  if (!hasGitBridge()) return
  await transport.call("git_set_identity", { repoPath, name, email, global })
}

/** Append a pattern to the repo-root `.gitignore` (no-op when already present). */
export async function gitIgnoreAdd(repoPath: string, pattern: string): Promise<void> {
  if (!hasGitBridge()) return
  await transport.call("git_ignore_add", { repoPath, pattern })
}

export async function gitMerge(repoPath: string, branch: string): Promise<void> {
  if (!hasGitBridge()) return
  await transport.call("git_merge", { repoPath, branch })
}

export async function gitMergeAbort(repoPath: string): Promise<void> {
  if (!hasGitBridge()) return
  await transport.call("git_merge_abort", { repoPath })
}

export async function gitRebase(repoPath: string, onto: string): Promise<void> {
  if (!hasGitBridge()) return
  await transport.call("git_rebase", { repoPath, onto })
}

export async function gitCherryPick(repoPath: string, sha: string): Promise<void> {
  if (!hasGitBridge()) return
  await transport.call("git_cherry_pick", { repoPath, sha })
}

export async function gitRevert(repoPath: string, sha: string): Promise<void> {
  if (!hasGitBridge()) return
  await transport.call("git_revert", { repoPath, sha })
}

export async function gitSequencerContinue(repoPath: string): Promise<void> {
  if (!hasGitBridge()) return
  await transport.call("git_sequencer_continue", { repoPath })
}

export async function gitSequencerAbort(repoPath: string): Promise<void> {
  if (!hasGitBridge()) return
  await transport.call("git_sequencer_abort", { repoPath })
}

/** Commits in `base..HEAD`, oldest first — the rows for the interactive rebase editor. */
export async function gitRebaseCommits(repoPath: string, base: string): Promise<GitCommit[]> {
  if (!hasGitBridge()) return []
  return transport.call<GitCommit[]>("git_rebase_commits", { repoPath, base })
}

export async function gitInteractiveRebase(
  repoPath: string,
  base: string,
  entries: RebaseTodoEntry[]
): Promise<void> {
  if (!hasGitBridge()) return
  await transport.call("git_interactive_rebase", { repoPath, base, entries })
}

// ── Stacked branches ───────────────────────────────────────────────────────
//
// These diverge from the rest of this file on purpose. Everywhere else a
// missing bridge means "return the empty answer" — a browser with no git shows
// an empty panel, which is honest. A stack operation cannot do that: a restack
// that quietly returns while the caller reports success to a person is how a
// stack ends up published from branches nobody moved. Reads stay inert; writes
// throw.

function requireGitBridge(operation: string): void {
  if (!hasGitBridge()) {
    throw new Error(`${operation} needs a Git bridge — this client has none.`)
  }
}

export async function gitStackCapabilities(repoPath: string): Promise<GitStackCapabilities | null> {
  if (!hasGitBridge()) return null
  return transport.call<GitStackCapabilities>("git_stack_capabilities", { repoPath })
}

/** Every recorded parent pointer in the repository, as `[child, parent]`. */
export async function gitStackParents(repoPath: string): Promise<Array<[string, string]>> {
  if (!hasGitBridge()) return []
  return transport.call<Array<[string, string]>>("git_stack_parents", { repoPath })
}

/** Record (or, with null, clear) a branch's parent. */
export async function gitStackSetParent(
  repoPath: string,
  branch: string,
  parent: string | null
): Promise<void> {
  requireGitBridge("Recording a stack parent")
  await transport.call("git_stack_set_parent", { repoPath, branch, parent })
}

export async function gitStackValidate(
  repoPath: string,
  branches: string[]
): Promise<GitStackLayerState[]> {
  if (!hasGitBridge()) return []
  return transport.call<GitStackLayerState[]>("git_stack_validate", { repoPath, branches })
}

export async function gitStackRestack(
  repoPath: string,
  onto: string,
  branches: string[]
): Promise<GitRestackOutcome> {
  requireGitBridge("Restacking")
  return transport.call<GitRestackOutcome>("git_stack_restack", { repoPath, onto, branches })
}

/** Previously recorded tips for a branch, newest first, as `[ref, oid]`. */
export async function gitStackHistory(
  repoPath: string,
  branch: string
): Promise<Array<[string, string]>> {
  if (!hasGitBridge()) return []
  return transport.call<Array<[string, string]>>("git_stack_history", { repoPath, branch })
}

/** Undo one branch's move, using a tip a restack pinned. */
export async function gitStackRevert(
  repoPath: string,
  branch: string,
  historyRef: string
): Promise<string> {
  requireGitBridge("Undoing a restack")
  return transport.call<string>("git_stack_revert", { repoPath, branch, historyRef })
}

export async function gitStackPush(
  repoPath: string,
  remote: string,
  branches: string[]
): Promise<GitStackPushOutcome> {
  requireGitBridge("Pushing a stack")
  return transport.call<GitStackPushOutcome>("git_stack_push", { repoPath, remote, branches })
}

// The fs watcher lives in Tauri managed state and is NOT a companion RPC —
// remote clients rely on the forwarded `git://status-changed` WS event, so
// these two stay `isTauri()`-gated (not `hasGitBridge()`).

export async function gitWatchStart(repoPath: string): Promise<void> {
  if (!isTauri()) return
  await transport.call("git_watch_start", { repoPath })
}

export async function gitWatchStop(repoPath: string): Promise<void> {
  if (!isTauri()) return
  await transport.call("git_watch_stop", { repoPath })
}
