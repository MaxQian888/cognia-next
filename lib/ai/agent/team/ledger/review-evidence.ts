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
 * Registry controller's Git boundary: this unit-tests without Tauri, and returns
 * `kind: "text"` on web/mobile where the git bridge is inert.
 */

import { gitDiffFile, gitDiffRefsFile, gitDiffRefsFiles, gitStatus } from "@/lib/git/commands"
import { gateTextForModel } from "@/lib/scm/review/pii-gate"
import { isSensitiveResourcePath } from "@/lib/task-workspace/run-changes"
import type { GitDiff, GitFileChange, GitStatus } from "@/types/git"
import type { PromotionWorkspaceHandle } from "../workspace/promotion"

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
 * meaningful together: committing is the Registry promotion controller's job,
 * and without a commit there is nothing on the branch to diff against
 * `repoPath`. Splitting them let a caller supply a repo with no way to commit,
 * which would silently produce "no diff" — the lead would then review prose
 * believing the worker changed nothing. The type now makes that unbuildable.
 */
export interface ReviewWorktreeSource {
  handle: PromotionWorkspaceHandle
  /** The team's main repo — the diff base for the worktree branch. */
  repoPath: string
  /** Commits the managed environment's work onto its promotion branch. */
  commit: (handle: PromotionWorkspaceHandle, message: string) => Promise<string | null>
  /** Ref the worktree branched from. Defaults to `HEAD`. */
  baseRef?: string
}

export interface BuildReviewEvidenceArgs {
  /** The task's worktree, when workspace isolation is on. */
  worktree?: ReviewWorktreeSource
  /** Shared working dir, used when there is no worktree. */
  workingDir?: string
  /**
   * The ref `workingDir` forked from, when it is a Registry environment. Its
   * committed changes (`base...HEAD`) are reviewed with the uncommitted ones:
   * a teammate that commits its own work would otherwise leave the lead an
   * empty working-tree diff and a review of prose (ADR-0227).
   */
  workingDirBase?: string
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
 * The base path of a part (`a.ts (uncommitted)` → `a.ts`), for the
 * sensitive-path check.
 */
function partPath(path: string): string {
  return path.replace(/ \(uncommitted\)$/, "")
}

/**
 * Concatenate per-file patches under the byte cap.
 *
 * Whole files are dropped rather than split: half a hunk is worse than an
 * honest "N files omitted", because a truncated patch reads as a complete one.
 *
 * Everything here goes to the lead's model, so each part is gated first
 * (ADR-0227; the PII rule in CLAUDE.md): a credential file is never included,
 * a patch is redacted and re-checked, and a part whose path or patch still
 * leaks is withheld. The lead is told how many were withheld, never which.
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
  let withheld = 0
  const sendable: Array<{ path: string; text: string }> = []
  for (const part of parts) {
    if (!part.text) continue
    if (isSensitiveResourcePath(partPath(part.path))) {
      withheld += 1
      continue
    }
    const path = gateTextForModel(part.path)
    const text = gateTextForModel(part.text)
    if (!path.ok || path.redacted || !text.ok) {
      withheld += 1
      continue
    }
    sendable.push({ path: part.path, text: text.text })
  }
  for (const part of sendable) {
    const size = utf8(part.text)
    if (bytes + size > MAX_REVIEW_DIFF_BYTES) {
      truncated = true
      continue
    }
    kept.push(part.text)
    files.push(part.path)
    bytes += size
  }
  const omitted = sendable.filter((p) => !files.includes(p.path)).map((p) => p.path)
  const notice = omitted.length
    ? `\n[${omitted.length} file(s) omitted to stay within the review diff limit: ${omitted.join(", ")}]\n`
    : ""
  const withheldNotice = withheld
    ? `\n[${withheld} file(s) withheld: sensitive files and personal data are never sent for review]\n`
    : ""
  return { diff: kept.join("\n") + notice + withheldNotice, truncated, files }
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

/** Per-file patches of a directory's uncommitted (staged + unstaged) changes. */
async function uncommittedParts(
  git: ReviewGitOps,
  dir: string
): Promise<Array<{ path: string; text: string }>> {
  const status = await git.status(dir)
  const seen = new Set<string>()
  const unique = [...status.staged, ...status.changes].filter(
    (f) => !seen.has(f.path) && seen.add(f.path)
  )
  return Promise.all(
    unique.map(async (f) => ({
      path: f.path,
      text: renderDiff(await git.diffFile(dir, f.path, f.staged)),
    }))
  )
}

/** Diff a directory's uncommitted (staged + unstaged) changes. */
async function uncommittedDiff(git: ReviewGitOps, dir: string): Promise<ReviewEvidence | null> {
  const parts = await uncommittedParts(git, dir)
  if (parts.length === 0) return null
  const { diff, truncated, files } = assemble(parts)
  if (!files.length && !truncated) return null
  return { kind: "worktree", diff, truncated, files }
}

/** Per-file patches of what `dir` committed since it forked from `base`. */
async function committedParts(
  git: ReviewGitOps,
  dir: string,
  base: string
): Promise<Array<{ path: string; text: string }>> {
  const changed = await git.diffRefsFiles(dir, base, "HEAD")
  return Promise.all(
    changed.map(async (f) => ({
      path: f.path,
      text: renderDiff(await git.diffRefsFile(dir, base, "HEAD", f.path)),
    }))
  )
}

/**
 * A Registry environment's whole change: committed since `base`, then
 * uncommitted. Either half failing costs that half, never the review.
 */
async function environmentDiff(
  git: ReviewGitOps,
  dir: string,
  base: string
): Promise<ReviewEvidence | null> {
  const committed = await committedParts(git, dir, base).catch(() => [])
  const dirty = await uncommittedParts(git, dir).catch(() => [])
  // A file both committed and edited again shows twice; the second is labelled
  // so the lead reads it as a later edit, not a duplicate.
  const committedPaths = new Set(committed.map((part) => part.path))
  const parts = [
    ...committed,
    ...dirty.map((part) =>
      committedPaths.has(part.path) ? { ...part, path: `${part.path} (uncommitted)` } : part
    ),
  ]
  if (parts.length === 0) return null
  const { diff, truncated, files } = assemble(parts)
  if (!files.length && !truncated) return null
  return {
    kind: committed.some((part) => part.text) ? "commit" : "worktree",
    diff,
    truncated,
    files,
  }
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
    if (args.workingDirBase) {
      const whole = await attempt(() =>
        environmentDiff(git, args.workingDir!, args.workingDirBase!)
      )
      return whole ?? EMPTY
    }
    const dirty = await attempt(() => uncommittedDiff(git, args.workingDir!))
    return dirty ?? EMPTY
  }

  return EMPTY
}
