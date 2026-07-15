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
  commit(worktreePath: string, message: string): Promise<string | null>
  diffRefsFiles(repoPath: string, base: string, target: string): Promise<GitFileChange[]>
  diffRefsFile(repoPath: string, base: string, target: string, path: string): Promise<GitDiff>
  status(repoPath: string): Promise<GitStatus>
  diffFile(repoPath: string, path: string, staged: boolean): Promise<GitDiff>
}

export interface BuildReviewEvidenceArgs {
  /** The task's worktree, when workspace isolation is on. */
  workspace?: WorktreeHandle
  /** Commits the worktree's work onto its branch. Usually `allocator.commit`. */
  commitWorkspace?: (handle: WorktreeHandle, message: string) => Promise<string | null>
  /** The team's main repo — the diff base for a worktree branch. */
  repoPath?: string
  /** Ref the worktree branched from. Defaults to `HEAD`. */
  baseRef?: string
  /** Shared working dir, used when there is no worktree. */
  workingDir?: string
  taskId: string
  git?: ReviewGitOps
}

const REAL_GIT: ReviewGitOps = {
  // `commit` is supplied by the allocator (it owns the worktree handle); the
  // rest are the plain wrappers.
  commit: async () => null,
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

/**
 * Assemble the diff the lead reviews.
 *
 * Order: the task's own worktree branch (committing whatever the worker left
 * uncommitted, so every revision round diffs the cumulative work against the
 * run's base) → uncommitted changes in the shared working dir → nothing, in
 * which case the deliverable text is the only evidence.
 */
export async function buildReviewEvidence(args: BuildReviewEvidenceArgs): Promise<ReviewEvidence> {
  const git = args.git ?? REAL_GIT
  const empty: ReviewEvidence = { kind: "text", truncated: false, files: [] }

  if (args.workspace && args.repoPath) {
    try {
      // Commit first: the worker is not required to commit, and an uncommitted
      // worktree has nothing to diff against the base ref. `commit` is a no-op
      // returning null when the tree is already clean.
      const sha = args.commitWorkspace
        ? await args.commitWorkspace(args.workspace, `agent: ${args.taskId}`)
        : await git.commit(args.workspace.path, `agent: ${args.taskId}`)

      const base = args.baseRef ?? "HEAD"
      const changed = await git.diffRefsFiles(args.repoPath, base, args.workspace.branch)
      if (changed.length === 0) return empty

      const parts = await Promise.all(
        changed.map(async (f) => ({
          path: f.path,
          text: renderDiff(
            await git.diffRefsFile(args.repoPath!, base, args.workspace!.branch, f.path)
          ),
        }))
      )
      const { diff, truncated, files } = assemble(parts)
      if (!files.length && !truncated) return empty
      return { kind: "commit", diff, truncated, files, ...(sha ? { commitSha: sha } : {}) }
    } catch {
      // Git is best-effort evidence, not the gate. Falling back to the text
      // keeps the review blocking (a failure here must not silently approve).
      return empty
    }
  }

  if (args.workingDir) {
    try {
      const status = await git.status(args.workingDir)
      const changed = [...status.staged, ...status.changes]
      const seen = new Set<string>()
      const unique = changed.filter((f) => !seen.has(f.path) && seen.add(f.path))
      if (unique.length === 0) return empty

      const parts = await Promise.all(
        unique.map(async (f) => ({
          path: f.path,
          text: renderDiff(await git.diffFile(args.workingDir!, f.path, f.staged)),
        }))
      )
      const { diff, truncated, files } = assemble(parts)
      if (!files.length && !truncated) return empty
      return { kind: "worktree", diff, truncated, files }
    } catch {
      return empty
    }
  }

  return empty
}
