/**
 * Per-hunk review decisions with content-hash remapping (Cursor-style accept /
 * reject / comment), ported as an algorithm and adapted to cognia's existing
 * Rust-parsed {@link GitHunk} shape (no new diff parser, no CodeMirror).
 *
 * Why content hashing: decisions are keyed `${reviewKey}:${hunkIndex}`, but a
 * file re-diffs as the working tree changes, so hunk indices shift. We persist
 * each decision alongside a hash of the hunk's content; on re-mount we recompute
 * hashes and remap a decision to whatever current hunk *uniquely* matches its
 * hash. Ambiguous (duplicate) or vanished hunks drop their decision rather than
 * guess. Pure — no React, no I/O.
 */

import type { GitFileStatus, GitHunk } from "@/types/git"

export type HunkDecision = "accepted" | "rejected" | "undecided"

/** One persisted decision, content-addressed for stable replay. */
export interface StoredHunkDecision {
  /** Index at the time the decision was made (best-effort fallback). */
  hunkIndex: number
  /** Content hash of the hunk when the decision was made. */
  hash: string
  decision: HunkDecision
  comment?: string
}

/** FNV-1a (base36) — copied from the rag embedding cache (separate workspace). */
export function fnv1aHash(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = (hash * 0x01000193) >>> 0
  }
  return hash.toString(36)
}

/**
 * Content hash of a hunk: `hash(oldContent + "\n" + newContent)` where
 * `oldContent` is every non-added line and `newContent` every non-deleted line
 * (context lines appear in both, matching the borrowed derivation). Stable
 * across index shifts when the hunk body is unchanged.
 */
export function hunkContentHash(hunk: GitHunk): string {
  const oldContent = hunk.lines
    .filter((l) => l.kind !== "add")
    .map((l) => l.content)
    .join("\n")
  const newContent = hunk.lines
    .filter((l) => l.kind !== "del")
    .map((l) => l.content)
    .join("\n")
  return fnv1aHash(`${oldContent}\n${newContent}`)
}

/** Normalize a path for review keys: forward slashes, lowercase Windows drive. */
function normalizeReviewPath(path: string): string {
  const slashed = (path ?? "").replace(/\\/g, "/")
  return slashed.replace(/^([a-zA-Z]):\//, (_m, d: string) => `${d.toLowerCase()}:/`)
}

/**
 * Stable per-file review key. Renames/copies use a `rename:old->new` alias so a
 * decision follows the file across the rename; everything else is the
 * normalized path. Deliberately omits stage state so a decision persists across
 * staging.
 */
export function normalizeReviewKey(change: {
  path: string
  origPath: string | null
  status: GitFileStatus
}): string {
  const path = normalizeReviewPath(change.path)
  if (change.status === "renamed" && change.origPath) {
    return `rename:${normalizeReviewPath(change.origPath)}->${path}`
  }
  return path
}

/**
 * Remap stored decisions onto the CURRENT hunks. A decision is applied only when
 * its stored hash matches exactly one current hunk (by content); 0 or ≥2
 * matches → dropped (the caller can surface "some decisions couldn't be
 * remapped"). Returns a map keyed by current hunk index.
 */
export function replayDecisions(
  stored: StoredHunkDecision[],
  currentHunks: GitHunk[]
): Map<number, { decision: HunkDecision; comment?: string }> {
  // Build hash → current-index list.
  const hashToIndices = new Map<string, number[]>()
  currentHunks.forEach((hunk, index) => {
    const hash = hunkContentHash(hunk)
    const arr = hashToIndices.get(hash) ?? []
    arr.push(index)
    hashToIndices.set(hash, arr)
  })

  const out = new Map<number, { decision: HunkDecision; comment?: string }>()
  for (const entry of stored) {
    if (entry.decision === "undecided" && !entry.comment) continue
    const candidates = hashToIndices.get(entry.hash)
    if (candidates && candidates.length === 1) {
      out.set(candidates[0], { decision: entry.decision, comment: entry.comment })
    }
    // 0 or ≥2 matches → ambiguous/vanished → drop.
  }
  return out
}

/**
 * Count stored decisions that could NOT be uniquely remapped onto the current
 * hunks (for a "some decisions couldn't be re-applied" notice).
 */
export function countUnmappedDecisions(
  stored: StoredHunkDecision[],
  currentHunks: GitHunk[]
): number {
  const remapped = replayDecisions(stored, currentHunks)
  const actionable = stored.filter((s) => s.decision !== "undecided" || s.comment)
  return Math.max(0, actionable.length - remapped.size)
}

/**
 * Accepted hunks, sorted by `newStart` DESCENDING so they can be staged
 * sequentially without earlier patches shifting later offsets.
 */
export function selectAcceptedPatches(
  hunks: GitHunk[],
  decisions: Map<number, { decision: HunkDecision }>
): GitHunk[] {
  return hunks
    .filter((_h, i) => decisions.get(i)?.decision === "accepted")
    .sort((a, b) => b.newStart - a.newStart)
}
