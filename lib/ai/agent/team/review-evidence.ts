/**
 * Deterministic diff evidence for the blocking lead review (ADR-0071).
 *
 * A reviewer that only sees the worker's prose is reviewing a claim, not the
 * work: an agent that says "added validation and tests" and changed nothing
 * reads identically to one that did. So the lead is shown what the task
 * actually changed on disk.
 *
 * Deterministic on purpose — no model, no tools, no network. The lead never
 * gets execution tools (that is the point of a reviewer), so the evidence has to
 * be assembled for it. It is also the only reason a review verdict is
 * reproducible across revisions.
 *
 * Git runs desktop-side in Rust, so everything goes through an injectable
 * `ReviewGitOps` seam — the same shape (and for the same reason) as the
 * allocator's `WorktreeGitOps`: this unit-tests without Tauri, and returns
 * `kind: "text"` on web/mobile where the git bridge is inert.
 */

import { gitDiffFile, gitDiffRefsFile, gitDiffRefsFiles, gitStatus } from "@/lib/git/commands"
import type { GitDiff, GitFileChange, GitStatus } from "@/types/git"
import type { WorktreeHandle } from "./workspace/allocator"

/**
 * Hard cap on the diff handed to the lead. Large enough to carry a real change
 * set, small enough that one runaway task cannot blow the reviewer's context
 * (and with it the whole run's budget). Counted in UTF-8 bytes because that is
 * what the cap is protecting — the wire, not the character count.
 */
export const MAX_REVIEW_DIFF_BYTES = 64 * 1024

export type ReviewEvidenceKind =
  /** Diff of the task's branch against the run's base — the normal case. */
  | "commit"
  /** Uncommitted changes in the shared working dir (isolation off). */
  | "worktree"
  /** No diff to be had: judge the written deliverable alone. */
  | "text"

export interface ReviewEvidence {
  kind: ReviewEvidenceKind
  /** Unified patch text. Absent for `kind: "text"`. */
  diff?: string
  /** True when the cap dropped content — the lead is told, so it can say so. */
  truncated: boolean
  /** Commit the diff was taken against, when we made one. */
  commitSha?: string
  /** Repo-relative paths included in `diff`. */
  files: string[]
}

/** Injectable git seam so this unit-tests without Tauri. */
export interface ReviewGitOps {
  diffRefsFiles(repoPath: string, base: string, target: string): Promise<GitFileChange[]>
  diffRefsFile(repoPath: string, base: string, target: string, path: string): Promise<GitDiff>
  status(repoPath: string): Promise<GitStatus>
  diffFile(repoPath: string, path: string, staged: boolean): Promise<GitDiff>
}

/**
 * The task's worktree and everything needed to diff it.
 *
 * One object rather than four loose optional fields, because they are only ever
 * meaningful together: committing is the allocator's job (it owns the handle),
 * and without a commit there is nothing on the branch to diff against
 * `repoPath`. Splitting them let a caller supply a repo with no way to commit,
 * which would silently produce "no diff" — the lead would then review prose
 * believing the worker changed nothing. The type now makes that unbuildable.
 */
export interface ReviewWorktreeSource {
  handle: WorktreeHandle
  /** The team's main repo — the diff base for the worktree branch. */
  repoPath: string
  /** Commits the worktree's work onto its branch. Usually `allocator.commit`. */
  commit: (handle: WorktreeHandle, message: string) => Promise<string | null>
  /** Ref the worktree branched from. Defaults to `HEAD`. */
  baseRef?: string
}

export interface BuildReviewEvidenceArgs {
  /** The task's worktree, when workspace isolation is on. */
  worktree?: ReviewWorktreeSource
  /** Shared working dir, used when there is no worktree. */
  workingDir?: string
  taskId: string
  git?: ReviewGitOps
}

const REAL_GIT: ReviewGitOps = {
  diffRefsFiles: gitDiffRefsFiles,
  diffRefsFile: gitDiffRefsFile,
  status: gitStatus,
  diffFile: gitDiffFile,
}

const utf8 = (s: string): number => new TextEncoder().encode(s).length

/** Render one file's hunks as a unified patch. `GitHunk.patch` is self-contained. */
function renderDiff(diff: GitDiff): string {
  if (diff.isBinary) return `--- ${diff.path}\n(binary file changed)\n`
  const body = diff.hunks.map((h) => h.patch).join("\n")
  return body ? `--- ${diff.path}\n${body}\n` : ""
}

/**
 * Concatenate per-file patches under the byte cap.
 *
 * Whole files are dropped rather than split: half a hunk is worse than an
 * honest "N files omitted", because a truncated patch reads as a complete one.
 */
function assemble(parts: Array<{ path: string; text: string }>): {
  diff: string
  truncated: boolean
  files: string[]
} {
  const kept: string[] = []
  const files: string[] = []
  let bytes = 0
  let truncated = false
  for (const part of parts) {
    if (!part.text) continue
    const size = utf8(part.text)
    if (bytes + size > MAX_REVIEW_DIFF_BYTES) {
      truncated = true
      continue
    }
    kept.push(part.text)
    files.push(part.path)
    bytes += size
  }
  const omitted = parts.filter((p) => p.text && !files.includes(p.path)).map((p) => p.path)
  const notice = omitted.length
    ? `\n[${omitted.length} file(s) omitted to stay within the review diff limit: ${omitted.join(", ")}]\n`
    : ""
  return { diff: kept.join("\n") + notice, truncated, files }
}

const EMPTY: ReviewEvidence = { kind: "text", truncated: false, files: [] }

/** Diff the task's branch against the run's base. `null` = nothing to show. */
async function branchDiff(
  git: ReviewGitOps,
  worktree: ReviewWorktreeSource,
  taskId: string
): Promise<ReviewEvidence | null> {
  // Commit first: the worker is not required to commit, and an uncommitted
  // worktree has nothing to diff against the base ref. `commit` returns null
  // when the tree is already clean (the usual case — the dispatcher commits).
  const sha = await worktree.commit(worktree.handle, `agent: ${taskId}`)

  const base = worktree.baseRef ?? "HEAD"
  const changed = await git.diffRefsFiles(worktree.repoPath, base, worktree.handle.branch)
  if (changed.length === 0) return null

  const parts = await Promise.all(
    changed.map(async (f) => ({
      path: f.path,
      text: renderDiff(
        await git.diffRefsFile(worktree.repoPath, base, worktree.handle.branch, f.path)
      ),
    }))
  )
  const { diff, truncated, files } = assemble(parts)
  if (!files.length && !truncated) return null
  return { kind: "commit", diff, truncated, files, ...(sha ? { commitSha: sha } : {}) }
}

/** Diff a directory's uncommitted (staged + unstaged) changes. */
async function uncommittedDiff(git: ReviewGitOps, dir: string): Promise<ReviewEvidence | null> {
  const status = await git.status(dir)
  const seen = new Set<string>()
  const unique = [...status.staged, ...status.changes].filter(
    (f) => !seen.has(f.path) && seen.add(f.path)
  )
  if (unique.length === 0) return null

  const parts = await Promise.all(
    unique.map(async (f) => ({
      path: f.path,
      text: renderDiff(await git.diffFile(dir, f.path, f.staged)),
    }))
  )
  const { diff, truncated, files } = assemble(parts)
  if (!files.length && !truncated) return null
  return { kind: "worktree", diff, truncated, files }
}

/** Run a rung, treating any git failure as "this rung produced nothing". */
async function attempt(fn: () => Promise<ReviewEvidence | null>): Promise<ReviewEvidence | null> {
  try {
    return await fn()
  } catch {
    // Git is best-effort EVIDENCE, not the gate: a failure here drops to the
    // next rung and ultimately to the text, never to an approval.
    return null
  }
}

/**
 * Assemble the diff the lead reviews.
 *
 * Rungs, in order: the task's own worktree branch → uncommitted changes (in
 * that worktree, else in the shared working dir) → nothing, in which case the
 * deliverable text is the only evidence. Each rung falls through on failure or
 * on finding no changes, so a git hiccup on the branch still gets the lead a
 * diff if the working tree has one.
 */
export async function buildReviewEvidence(args: BuildReviewEvidenceArgs): Promise<ReviewEvidence> {
  const git = args.git ?? REAL_GIT

  if (args.worktree) {
    const branch = await attempt(() => branchDiff(git, args.worktree!, args.taskId))
    if (branch) return branch
    // The branch rung came up empty — try what is sitting in the worktree
    // uncommitted (e.g. the commit itself failed). Never the shared workingDir:
    // the work is in the worktree, so diffing the shared dir would be evidence
    // about the wrong directory.
    const dirty = await attempt(() => uncommittedDiff(git, args.worktree!.handle.path))
    return dirty ?? EMPTY
  }

  if (args.workingDir) {
    const dirty = await attempt(() => uncommittedDiff(git, args.workingDir!))
    return dirty ?? EMPTY
  }

  return EMPTY
}
