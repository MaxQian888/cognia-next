/**
 * Pure presentation helpers for a single-file git diff and the review list
 * around it: when a diff is too large for Monaco, how its hunks render without
 * Monaco, which hunk the reader is in, and the order "next file" walks.
 *
 * Kept free of React so the dock review, the source-control page and their
 * tests share one answer to each question.
 */

import type { DiffLine } from "@/types"
import type { DiffRow } from "@/lib/artifacts/diff"
import type { GitDiff, GitHunk, GitStatus } from "@/types/git"

/**
 * Above either limit a diff opens in the hunk view instead of the Monaco
 * DiffEditor. Monaco re-diffs both full texts on the UI thread and lays out a
 * model per side; past a megabyte or two that is a visible stall in a dock
 * that re-renders on every agent write, for a change the hunks already show.
 */
export const MONACO_DIFF_CHAR_LIMIT = 1_500_000
export const MONACO_DIFF_LINE_LIMIT = 40_000

function countLines(text: string): number {
  if (text.length === 0) return 0
  let lines = 1
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) lines++
  return lines
}

export type DiffPresentation =
  /** Full texts present and small enough for the Monaco DiffEditor. */
  | "monaco"
  /** Full texts present but large: hunks by default, full diff on request. */
  | "large"
  /** The host left the full texts out (`contentOmitted`): hunks only. */
  | "hunks-only"

/** How a text diff should open. Binary diffs are handled before this. */
export function diffPresentation(diff: GitDiff): DiffPresentation {
  if (diff.contentOmitted) return "hunks-only"
  const chars = diff.oldContent.length + diff.newContent.length
  if (chars > MONACO_DIFF_CHAR_LIMIT) return "large"
  // Only count lines once the cheap check passes; a long minified line is
  // caught by the character limit above.
  const lines = countLines(diff.oldContent) + countLines(diff.newContent)
  return lines > MONACO_DIFF_LINE_LIMIT ? "large" : "monaco"
}

/** Strip the line terminator libgit2 leaves on every hunk line. */
function stripEol(content: string): string {
  if (content.endsWith("\r\n")) return content.slice(0, -2)
  if (content.endsWith("\n")) return content.slice(0, -1)
  return content
}

/**
 * Render rows for a diff's hunks: one fixed header per hunk (the lines between
 * hunks were never loaded, so they are not an expandable gap), then each line
 * numbered from the hunk's own start on each side.
 *
 * A hunk with an empty header is a bare run of change lines from a pasted
 * diff (`parseUnifiedPatch`): it has no position in any file, so it gets
 * neither a header row nor line numbers rather than invented ones.
 */
export function gitHunksToDiffRows(hunks: readonly GitHunk[]): DiffRow[] {
  const rows: DiffRow[] = []
  let index = 0
  hunks.forEach((hunk, h) => {
    const numbered = hunk.header !== ""
    if (numbered) rows.push({ kind: "header", key: `hunk-${h}`, text: hunk.header })
    let oldLine = hunk.oldStart
    let newLine = hunk.newStart
    for (const raw of hunk.lines) {
      const content = stripEol(raw.content)
      let line: DiffLine
      if (raw.kind === "add") {
        line = { type: "added", content, ...(numbered ? { newLineNum: newLine++ } : {}) }
      } else if (raw.kind === "del") {
        line = { type: "removed", content, ...(numbered ? { oldLineNum: oldLine++ } : {}) }
      } else {
        line = {
          type: "unchanged",
          content,
          ...(numbered ? { oldLineNum: oldLine++, newLineNum: newLine++ } : {}),
        }
      }
      rows.push({ kind: "line", line, index: index++ })
    }
  })
  return rows
}

/** Lines added / removed across every hunk. */
export function hunkStats(hunks: readonly GitHunk[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "add") added++
      else if (line.kind === "del") removed++
    }
  }
  return { added, removed }
}

/**
 * The hunk the reader is in, given a line on the MODIFIED side: the hunk whose
 * range covers it, else the last hunk that starts before it. `-1` above the
 * first hunk. A pure deletion has `newLines === 0` and still owns its anchor
 * line, so it can be the current hunk too.
 */
export function hunkIndexAtLine(hunks: readonly GitHunk[], line: number): number {
  let current = -1
  for (let i = 0; i < hunks.length; i++) {
    const start = hunks[i].newStart
    const end = start + Math.max(hunks[i].newLines, 1)
    if (line >= start && line < end) return i
    if (start <= line) current = i
  }
  return current
}

/** One reviewable file: the same path can appear staged AND unstaged. */
export interface ReviewFileRef {
  path: string
  staged: boolean
}

/**
 * The files in the order the review list shows them — Merge, Staged, Changes —
 * so "next file" in the diff header walks the list the reader sees.
 */
export function orderedReviewFiles(status: GitStatus | null | undefined): ReviewFileRef[] {
  if (!status) return []
  return [
    ...status.merge.map((c) => ({ path: c.path, staged: false })),
    ...status.staged.map((c) => ({ path: c.path, staged: true })),
    ...status.changes.map((c) => ({ path: c.path, staged: false })),
  ]
}

/**
 * Resolve which side a reveal for `path` should open. A file that only exists
 * as a staged change has an empty working-tree diff, so a reveal that always
 * asked for the unstaged side opened a blank pane for it.
 */
export function resolveReviewSide(
  status: GitStatus | null | undefined,
  path: string
): ReviewFileRef {
  if (!status) return { path, staged: false }
  const unstaged =
    status.changes.some((c) => c.path === path) || status.merge.some((c) => c.path === path)
  if (unstaged) return { path, staged: false }
  if (status.staged.some((c) => c.path === path)) return { path, staged: true }
  return { path, staged: false }
}

/** Position of `current` in `files`, with its neighbours, for prev/next. */
export function reviewFileNeighbours(
  files: readonly ReviewFileRef[],
  current: ReviewFileRef | null
): { index: number; prev: ReviewFileRef | null; next: ReviewFileRef | null } {
  if (!current) return { index: -1, prev: null, next: null }
  const index = files.findIndex((f) => f.path === current.path && f.staged === current.staged)
  if (index === -1) return { index, prev: null, next: null }
  return {
    index,
    prev: index > 0 ? files[index - 1] : null,
    next: index < files.length - 1 ? files[index + 1] : null,
  }
}
