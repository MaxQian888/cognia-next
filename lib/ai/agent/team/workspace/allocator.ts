/**
 * Per-dispatch git-worktree allocator for agent-team workspace isolation.
 *
 * When a team run has `workspaceIsolation.enabled`, the run builds one
 * `AgentWorkspaceAllocator` (stashed on `TeamRunContext`). Each teammate
 * dispatch calls `allocate()` to get its own linked worktree + branch off the
 * run's base HEAD, so parallel agents never share a working tree / index /
 * branch. `pipeline` reconcile passes a shared `workspaceKey` so a chain of
 * dependent dispatches reuses one worktree.
 *
 * The allocator is pure orchestration over an injectable `WorktreeGitOps`
 * seam (default = the real `lib/git/commands` wrappers), so it unit-tests
 * without Tauri. All real git work runs desktop-side in Rust.
 */

import {
  gitWorktreeAdd,
  gitWorktreeCommit,
  gitWorktreeList,
  gitWorktreeRemove,
} from "@/lib/git/commands"
import type { GitWorktree } from "@/types/git"

export interface WorktreeHandle {
  /** Allocation key = `workspaceKey ?? taskId`. Identity for pipeline reuse. */
  key: string
  runId: string
  teammateName: string
  taskId: string
  /** `agent/<runId>/<teammate>/<taskId>`. */
  branch: string
  /** Absolute worktree working directory. */
  path: string
}

export interface AllocateArgs {
  runId: string
  teammateName: string
  taskId: string
  /**
   * Groups dispatches that must share one worktree (pipeline handoff).
   * Defaults to `taskId` → one worktree per dispatch.
   */
  workspaceKey?: string
}

/** Injectable git seam so the allocator is testable without Tauri. */
export interface WorktreeGitOps {
  add(repoPath: string, path: string, branch: string, baseRef?: string): Promise<void>
  remove(repoPath: string, path: string, force: boolean, deleteBranch?: string): Promise<void>
  list(repoPath: string): Promise<GitWorktree[]>
  commit(worktreePath: string, message: string): Promise<string | null>
}

const REAL_GIT: WorktreeGitOps = {
  add: gitWorktreeAdd,
  remove: gitWorktreeRemove,
  list: gitWorktreeList,
  commit: gitWorktreeCommit,
}

export interface AllocatorOptions {
  /** The team's main repo (its `workingDir`). */
  mainRepo: string
  /**
   * Absolute base dir for linked worktrees. Defaults to a hidden sibling of the
   * repo: `<parent>/.cognia-agent-worktrees/<repoName>`.
   */
  worktreeBase?: string
  /** Branch-point for every agent branch. Defaults to the repo's current HEAD. */
  baseRef?: string
  git?: WorktreeGitOps
  /** Unique path-suffix generator (injected for deterministic tests). */
  uid?: () => string
  /** Max attempts for a lock-contended `worktree add`. Default 3. */
  maxAttempts?: number
  /** Delay between retries (injected in tests to skip real waiting). */
  delay?: (attempt: number) => Promise<void>
}

const UNSAFE_SEGMENT = /[^a-zA-Z0-9._-]+/g

/** Reduce an arbitrary name to a git-branch- and path-safe segment. */
export function sanitizeSegment(raw: string): string {
  const cleaned = raw.replace(UNSAFE_SEGMENT, "-").replace(/^[-.]+|[-.]+$/g, "")
  return cleaned.length > 0 ? cleaned : "x"
}

/**
 * `<parent>/.cognia-agent-worktrees/<repoName>` — a hidden sibling of the repo
 * so worktrees never appear as untracked files inside it. Always emits
 * forward-slash paths (git accepts them on Windows too).
 */
export function defaultWorktreeBase(mainRepo: string): string {
  const norm = mainRepo.replace(/\\/g, "/").replace(/\/+$/, "")
  const idx = norm.lastIndexOf("/")
  const parent = idx >= 0 ? norm.slice(0, idx) : "."
  const repoName = idx >= 0 ? norm.slice(idx + 1) : norm
  return `${parent}/.cognia-agent-worktrees/${sanitizeSegment(repoName)}`
}

/** True when a git error signals index/ref lock contention (retry-worthy). */
function isLockError(err: unknown): boolean {
  const rec = err as { kind?: unknown } | null
  if (rec && typeof rec === "object" && rec.kind === "lockHeld") return true
  let text: string
  try {
    text = typeof err === "string" ? err : JSON.stringify(err)
  } catch {
    text = String(err)
  }
  const message = (err as { message?: unknown } | null)?.message
  if (typeof message === "string") text += ` ${message}`
  return /lock/i.test(text)
}

let pathCounter = 0

export class AgentWorkspaceAllocator {
  private readonly mainRepo: string
  private readonly worktreeBase: string
  private readonly baseRef?: string
  private readonly git: WorktreeGitOps
  private readonly uid: () => string
  private readonly maxAttempts: number
  private readonly delay: (attempt: number) => Promise<void>
  private readonly handles = new Map<string, WorktreeHandle>()

  constructor(options: AllocatorOptions) {
    this.mainRepo = options.mainRepo
    this.worktreeBase = options.worktreeBase ?? defaultWorktreeBase(options.mainRepo)
    this.baseRef = options.baseRef
    this.git = options.git ?? REAL_GIT
    this.uid = options.uid ?? (() => (++pathCounter).toString(36))
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3)
    this.delay = options.delay ?? ((attempt) => new Promise((r) => setTimeout(r, 50 * attempt)))
  }

  get repo(): string {
    return this.mainRepo
  }

  /** Handles allocated so far this run (for reconcile / panel enumeration). */
  allocated(): WorktreeHandle[] {
    return [...this.handles.values()]
  }

  /**
   * Allocate (or, for a repeated `workspaceKey`, reuse) a worktree + branch.
   * Fail-closed: a non-lock error propagates so the dispatch errors rather than
   * silently running in the shared dir. Lock contention retries with backoff.
   */
  async allocate(args: AllocateArgs): Promise<WorktreeHandle> {
    const key = args.workspaceKey ?? args.taskId
    const existing = this.handles.get(key)
    if (existing) return existing

    const branch = `agent/${args.runId}/${sanitizeSegment(args.teammateName)}/${sanitizeSegment(
      args.taskId
    )}`
    const path = `${this.worktreeBase}/${args.runId}/${sanitizeSegment(key)}-${this.uid()}`

    let lastErr: unknown
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        await this.git.add(this.mainRepo, path, branch, this.baseRef)
        const handle: WorktreeHandle = {
          key,
          runId: args.runId,
          teammateName: args.teammateName,
          taskId: args.taskId,
          branch,
          path,
        }
        this.handles.set(key, handle)
        return handle
      } catch (err) {
        lastErr = err
        if (attempt < this.maxAttempts && isLockError(err)) {
          await this.delay(attempt)
          continue
        }
        throw err
      }
    }
    throw lastErr
  }

  /** Stage-all + commit the agent's work onto its branch. `null` if clean. */
  async commit(handle: WorktreeHandle, message: string): Promise<string | null> {
    return this.git.commit(handle.path, message)
  }

  /** Remove one worktree; optionally `-D` its branch. Forgets the handle. */
  async remove(handle: WorktreeHandle, opts?: { deleteBranch?: boolean }): Promise<void> {
    await this.git.remove(
      this.mainRepo,
      handle.path,
      true,
      opts?.deleteBranch ? handle.branch : undefined
    )
    this.handles.delete(handle.key)
  }

  /**
   * Remove every worktree allocated this run (crash/run-end cleanup). Best
   * effort — a single bad worktree never aborts the pass.
   */
  async gc(opts?: { deleteBranches?: boolean }): Promise<void> {
    const deleteBranch = opts?.deleteBranches ?? true
    for (const handle of this.allocated()) {
      try {
        await this.remove(handle, { deleteBranch })
      } catch {
        // best-effort GC
      }
    }
  }
}
