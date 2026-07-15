/**
 * Reconcile the per-dispatch agent branches produced by an isolated team run
 * (or a fan-out group) once they settle. Four modes:
 *
 *   - `manual`     — leave every branch for the user to review/merge (default).
 *   - `merge-all`  — merge each successful branch into a fresh integration
 *                    branch **in its own worktree** (never the user's checkout);
 *                    a conflict aborts that merge and is reported.
 *   - `select`     — keep one branch per `selectStrategy`, discard the rest.
 *   - `pipeline`   — the chain already produced one shared branch; return it.
 *
 * Safety: nothing here ever touches the user's real branch/working tree. The
 * integration merge runs in a scratch worktree the allocator owns. `merge` /
 * `mergeAbort` are injectable so the mode logic unit-tests without Tauri.
 */

import { gitMerge, gitMergeAbort } from "@/lib/git/commands"
import type { AgentWorkspaceAllocator, WorktreeHandle } from "./allocator"

export type ReconcileMode = "manual" | "merge-all" | "select" | "pipeline"
export type SelectStrategy = "manual" | "first-success" | "judge"
export type RetainPolicy = "all" | "keep-winner" | "prune-losers"

export interface ReconcileCandidate {
  handle: WorktreeHandle
  /** Did the teammate dispatch succeed (non-empty, validated output)? */
  ok: boolean
  /** Teammate output — context for the `judge` select strategy. */
  output?: string
  /**
   * Commit the blocking lead review (ADR-0071) took its diff against, recorded
   * by the review node. Present only for a reviewed task whose worker actually
   * changed something; reconcile does not depend on it (it merges branches, not
   * commits) — it is the record of what was reviewed and approved.
   */
  reviewedCommitSha?: string
}

export interface ReconcileResult {
  mode: ReconcileMode
  /** Branches still present after reconcile (drives the worktrees panel). */
  branches: string[]
  /** Integration branch (`merge-all`) or the selected branch (`select`). */
  resultBranch?: string
  /** The merge conflict that aborted `merge-all`, if any. */
  conflict?: { branch: string; detail: string }
  /** Selected candidate key (`select`). */
  winnerKey?: string
  /** One-line summary for the activity event. */
  summary: string
}

/** Injectable merge seam (default = the real `lib/git/commands` wrappers). */
export interface MergeOps {
  merge(repoPath: string, branch: string): Promise<void>
  mergeAbort(repoPath: string): Promise<void>
}

const REAL_MERGE: MergeOps = { merge: gitMerge, mergeAbort: gitMergeAbort }

export interface ReconcileOptions {
  runId: string
  mode: ReconcileMode
  selectStrategy?: SelectStrategy
  retain?: RetainPolicy
  /** Injected reviewer for `select` + `judge`; returns the winning candidate key. */
  judge?: (candidates: ReconcileCandidate[]) => Promise<string | null>
  merge?: MergeOps
}

function errText(err: unknown): string {
  const detail = (err as { detail?: unknown } | null)?.detail
  if (typeof detail === "string") return detail
  const message = (err as { message?: unknown } | null)?.message
  if (typeof message === "string") return message
  return String(err)
}

export async function reconcile(
  allocator: AgentWorkspaceAllocator,
  candidates: ReconcileCandidate[],
  options: ReconcileOptions
): Promise<ReconcileResult> {
  switch (options.mode) {
    case "pipeline":
      return reconcilePipeline(candidates)
    case "merge-all":
      return reconcileMergeAll(allocator, candidates, options)
    case "select":
      return reconcileSelect(allocator, candidates, options)
    case "manual":
    default:
      return {
        mode: "manual",
        branches: candidates.map((c) => c.handle.branch),
        summary: `${candidates.length} agent branch(es) left for manual review`,
      }
  }
}

function reconcilePipeline(candidates: ReconcileCandidate[]): ReconcileResult {
  // A pipeline shares one worktree, so all candidates carry the same branch.
  const branch = candidates[0]?.handle.branch
  return {
    mode: "pipeline",
    branches: branch ? [branch] : [],
    resultBranch: branch,
    summary: branch ? `pipeline produced ${branch}` : "pipeline produced no branch",
  }
}

async function reconcileMergeAll(
  allocator: AgentWorkspaceAllocator,
  candidates: ReconcileCandidate[],
  options: ReconcileOptions
): Promise<ReconcileResult> {
  const merge = options.merge ?? REAL_MERGE
  const succeeded = candidates.filter((c) => c.ok)

  // Integration branch in its own scratch worktree off baseRef — never the
  // user's checkout. `allocate` branches off the run's base HEAD.
  const integration = await allocator.allocate({
    runId: options.runId,
    teammateName: "integration",
    taskId: "all",
    workspaceKey: `__integration_${options.runId}`,
  })

  for (const c of succeeded) {
    try {
      await merge.merge(integration.path, c.handle.branch)
    } catch (err) {
      await merge.mergeAbort(integration.path).catch(() => undefined)
      return {
        mode: "merge-all",
        resultBranch: integration.branch,
        conflict: { branch: c.handle.branch, detail: errText(err) },
        branches: [integration.branch, ...candidates.map((x) => x.handle.branch)],
        summary: `merge conflict integrating ${c.handle.branch}; aborted`,
      }
    }
  }

  // Success — optionally clean up the agent worktrees (keep their branches).
  if ((options.retain ?? "keep-winner") !== "all") {
    for (const c of candidates) {
      await allocator.remove(c.handle, { deleteBranch: false }).catch(() => undefined)
    }
  }

  return {
    mode: "merge-all",
    resultBranch: integration.branch,
    branches: [integration.branch],
    summary: `merged ${succeeded.length} branch(es) into ${integration.branch}`,
  }
}

async function reconcileSelect(
  allocator: AgentWorkspaceAllocator,
  candidates: ReconcileCandidate[],
  options: ReconcileOptions
): Promise<ReconcileResult> {
  const strategy = options.selectStrategy ?? "manual"

  let winner: ReconcileCandidate | undefined
  if (strategy === "first-success") {
    winner = candidates.find((c) => c.ok)
  } else if (strategy === "judge" && options.judge) {
    const key = await options.judge(candidates)
    winner = candidates.find((c) => c.handle.key === key) ?? candidates.find((c) => c.ok)
  }

  // `manual` (or judge with no callback) defers the choice to the UI.
  if (strategy === "manual" || (strategy === "judge" && !options.judge)) {
    return {
      mode: "select",
      branches: candidates.map((c) => c.handle.branch),
      summary: `${candidates.length} candidate branch(es) awaiting manual selection`,
    }
  }

  if (!winner) {
    return {
      mode: "select",
      branches: candidates.map((c) => c.handle.branch),
      summary: "no successful candidate to select",
    }
  }

  // Discard losers unless retaining all.
  if ((options.retain ?? "keep-winner") !== "all") {
    for (const c of candidates) {
      if (c.handle.key !== winner.handle.key) {
        await allocator.remove(c.handle, { deleteBranch: true }).catch(() => undefined)
      }
    }
  }

  return {
    mode: "select",
    winnerKey: winner.handle.key,
    resultBranch: winner.handle.branch,
    branches: [winner.handle.branch],
    summary: `selected ${winner.handle.branch} (${strategy})`,
  }
}
