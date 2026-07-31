/**
 * Type-only shapes for the live-activity diff producer. Kept separate from
 * the LCS engine so the connector layer has a stable import path that does
 * NOT pull `cli/src/tui/markdown/` (which brings Ink/ANSI highlighting
 * deps into the connector bundle). Structurally identical to the CLI's
 * `DiffLine` so a single renderer vocabulary spans both surfaces; if the
 * CLI type ever diverges we copy the delta here intentionally.
 */

/**
 * A single line of a unified diff.
 *
 *   - `add`    — line present only in the new version (prefixed `+`).
 *   - `del`    — line present only in the old version (prefixed `-`).
 *   - `context`— unchanged line carried for surrounding context (prefixed ` `).
 *   - `meta`   — a `--- a/path` / `+++ b/path` / `@@ ... @@` header line.
 */
export interface DiffLine {
  kind: "add" | "del" | "context" | "meta"
  text: string
  /** 1-based line number on the old (deleted) side, when applicable. */
  oldNo?: number
  /** 1-based line number on the new (added) side, when applicable. */
  newNo?: number
}

/** One unified-diff hunk: a contiguous run of changed lines plus context. */
export interface DiffHunk {
  /** 1-based start line in the old file (0 when the hunk is pure insertion). */
  oldStart: number
  /** Number of old-file lines the hunk spans (0 for pure insertion). */
  oldLength: number
  /** 1-based start line in the new file (0 when the hunk is pure deletion). */
  newStart: number
  /** Number of new-file lines the hunk spans (0 for pure deletion). */
  newLength: number
  /** Ordered diff lines (context + add + del) — no `meta` header. */
  lines: DiffLine[]
}

/** Aggregate line counts for a set of hunks. */
export interface DiffStats {
  added: number
  removed: number
}
