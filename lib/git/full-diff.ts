/**
 * Rebuild the full texts of a diff the host sent as hunks only.
 *
 * Past `FULL_CONTENT_CAP` (`crates/cognia-git/src/diff.rs`) a file diff
 * arrives with `contentOmitted` and empty `oldContent` / `newContent`, so the
 * viewer can only show the changed sections. Asking for "the whole file"
 * does not need a second git command: git's hunks describe every difference
 * between the two sides, so one side plus the hunks IS the other side.
 *
 * - A working-tree diff (index ↔ disk) reads the file from disk, which the
 *   workspace fs already does, and reverse-applies the hunks for the index.
 * - A staged diff (HEAD ↔ index) reads HEAD's blob and forward-applies them.
 *
 * Every context and removed line is checked against the text it is applied
 * to, so a file that moved on since the hunks were read is reported as stale
 * rather than rebuilt wrong.
 */

import type { GitDiff, GitHunk } from "@/types/git"

/** The text no longer matches the hunks (the file changed since they were read). */
export class StaleHunksError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "StaleHunksError"
  }
}

/** Lines with their terminators, the way libgit2 hands hunk lines over. */
function splitKeepingEol(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? []
}

/**
 * Apply `hunks` to `text`. `forward` turns the old side into the new one;
 * `reverse` turns the new side back into the old one. Throws
 * {@link StaleHunksError} when a line the hunks expect is not there.
 */
export function applyHunks(
  text: string,
  hunks: readonly GitHunk[],
  direction: "forward" | "reverse"
): string {
  const source = splitKeepingEol(text)
  const forward = direction === "forward"
  // The side the hunks are applied to: `keep` lines are copied through,
  // `drop` lines must match and are skipped, `emit` lines are written.
  const drop = forward ? "del" : "add"
  const emit = forward ? "add" : "del"
  const ordered = [...hunks].sort((a, b) =>
    forward ? a.oldStart - b.oldStart : a.newStart - b.newStart
  )
  const out: string[] = []
  let pos = 0
  for (const hunk of ordered) {
    const start = forward ? hunk.oldStart : hunk.newStart
    const count = forward ? hunk.oldLines : hunk.newLines
    // An empty side's start names the line BEFORE the change (`-0,0` for a
    // file that did not exist).
    const at = count === 0 ? start : start - 1
    if (at < pos || at > source.length) {
      throw new StaleHunksError(`hunk ${hunk.header} does not fit the file`)
    }
    for (; pos < at; pos++) out.push(source[pos])
    for (const line of hunk.lines) {
      if (line.kind === emit) {
        out.push(line.content)
        continue
      }
      if (source[pos] !== line.content) {
        throw new StaleHunksError(`hunk ${hunk.header} no longer matches line ${pos + 1}`)
      }
      if (line.kind !== drop) out.push(source[pos])
      pos++
    }
  }
  for (; pos < source.length; pos++) out.push(source[pos])
  return out.join("")
}

/** True when the hunks remove every line and add none: the file is gone. */
function deletesWholeFile(hunks: readonly GitHunk[]): boolean {
  return hunks.length > 0 && hunks.every((h) => h.newLines === 0 && h.newStart === 0)
}

/** True when the hunks add every line and remove none: the file is new. */
function createsWholeFile(hunks: readonly GitHunk[]): boolean {
  return hunks.length > 0 && hunks.every((h) => h.oldLines === 0 && h.oldStart === 0)
}

export interface FullDiffSources {
  /** The file as it is on disk (working-tree diffs). */
  readWorkingFile: () => Promise<string>
  /** The file at HEAD, `null` when it does not exist there (staged diffs). */
  readHeadBlob: () => Promise<string | null>
}

/**
 * The same diff with both full texts filled in. Rejects with
 * {@link StaleHunksError} when the file moved on since `diff` was read, or
 * with the read's own error.
 */
export async function loadFullGitDiff(
  diff: GitDiff,
  staged: boolean,
  sources: FullDiffSources
): Promise<GitDiff> {
  let oldContent: string
  let newContent: string
  if (staged) {
    oldContent = createsWholeFile(diff.hunks) ? "" : ((await sources.readHeadBlob()) ?? "")
    newContent = applyHunks(oldContent, diff.hunks, "forward")
  } else {
    newContent = deletesWholeFile(diff.hunks) ? "" : await sources.readWorkingFile()
    oldContent = applyHunks(newContent, diff.hunks, "reverse")
  }
  return { ...diff, oldContent, newContent, contentOmitted: false }
}
