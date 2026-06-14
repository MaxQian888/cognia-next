/**
 * Unified-diff producer for the live-activity card (Feature A counting +
 * Feature B rendering). Pure functions — no Dexie, no bus, no React.
 *
 * Why a bespoke engine (not the `diff` npm package): the project doesn't
 * depend on one and the CLI's `cli/src/tui/markdown/diff.ts` does NOT
 * compute unified hunks (it only emits flat add/del lines per Edit field,
 * no context, no `+N −M` counting). The activity card needs real hunks
 * with `@@ -a,b +c,d @@` headers + an accurate line delta, so we ship a
 * minimal LCS-based producer here. Input is capped to avoid pathological
 * O(n²) on large writes — above the cap we fall back to a rough line-count
 * delta (`fallbackStats`) so the card's `+N −M` stays meaningful.
 *
 * The Edit/Write/MultiEdit field-name detection mirrors the CLI's
 * `formatEditDiff` aliases (`file_path`/`filePath`/`path`,
 * `old_string`/`new_string`, `edits[]`, `content`/`contents`) so the two
 * surfaces agree on which tool inputs are file edits.
 */
import type { DiffHunk, DiffLine, DiffStats } from "./diff-types"

/** Inputs above this many bytes skip the LCS pass (fallback to rough stats). */
export const MAX_DIFF_BYTES = 100 * 1024
/** Default unified-diff context lines around each changed region. */
export const DEFAULT_CONTEXT_LINES = 3

/** Read a string field, accepting common casing/spelling aliases. */
function str(...candidates: unknown[]): string | undefined {
  for (const c of candidates) if (typeof c === "string") return c
  return undefined
}

/** Pull the edited file's path out of an edit/write tool input. */
function readFilePath(input: Record<string, unknown>): string | undefined {
  return str(input.file_path, input.filePath, input.path, input.fileName)
}

interface RawOp {
  type: "context" | "del" | "add"
  /** 1-based old-file line number (set on context + del). */
  oldNo?: number
  /** 1-based new-file line number (set on context + add). */
  newNo?: number
  text: string
}

/**
 * Classic LCS backtrack over two line arrays. Returns an ordered op list
 * (context / del / add) with 1-based line numbers. O(n·m) — caller caps
 * input size.
 */
function lcsDiff(a: string[], b: string[]): RawOp[] {
  const n = a.length
  const m = b.length
  // dp[i][j] = length of LCS of a[i..] and b[j..]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i]
    const next = dp[i + 1]
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? next[j + 1] + 1 : Math.max(next[j], row[j + 1])
    }
  }
  const ops: RawOp[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "context", oldNo: i + 1, newNo: j + 1, text: a[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "del", oldNo: i + 1, text: a[i] })
      i++
    } else {
      ops.push({ type: "add", newNo: j + 1, text: b[j] })
      j++
    }
  }
  while (i < n) {
    ops.push({ type: "del", oldNo: i + 1, text: a[i] })
    i++
  }
  while (j < m) {
    ops.push({ type: "add", newNo: j + 1, text: b[j] })
    j++
  }
  return ops
}

/**
 * Group a raw op stream into unified-diff hunks: each maximal run of
 * changes, expanded by `context` lines on each side, with adjacent/overlapping
 * windows merged into one hunk (so a 2-line gap between two changes becomes
 * a single hunk rather than two with a 1-line context bridge).
 */
function groupIntoHunks(ops: RawOp[], context: number): DiffHunk[] {
  const len = ops.length
  if (len === 0) return []
  const isChange = (o: RawOp): boolean => o.type !== "context"

  // Indices of change ops.
  const changeIdx: number[] = []
  for (let k = 0; k < len; k++) if (isChange(ops[k])) changeIdx.push(k)
  if (changeIdx.length === 0) return []

  const hunks: DiffHunk[] = []
  let groupStart = changeIdx[0]
  let groupEnd = changeIdx[0]
  for (let c = 1; c < changeIdx.length; c++) {
    const idx = changeIdx[c]
    // Merge if the gap between this change and the running group end is
    // <= 2*context (the two context windows would overlap or touch).
    if (idx - groupEnd - 1 <= context * 2) {
      groupEnd = idx
    } else {
      hunks.push(buildHunk(ops, groupStart, groupEnd, context))
      groupStart = idx
      groupEnd = idx
    }
  }
  hunks.push(buildHunk(ops, groupStart, groupEnd, context))
  return hunks
}

function buildHunk(
  ops: RawOp[],
  changeStart: number,
  changeEnd: number,
  context: number
): DiffHunk {
  const len = ops.length
  const lo = Math.max(0, changeStart - context)
  const hi = Math.min(len - 1, changeEnd + context)
  const lines: DiffLine[] = []
  let oldStart = 0
  let newStart = 0
  let oldLen = 0
  let newLen = 0
  for (let k = lo; k <= hi; k++) {
    const op = ops[k]
    const line: DiffLine = { kind: op.type, text: op.text }
    if (op.oldNo !== undefined) {
      line.oldNo = op.oldNo
      if (oldStart === 0) oldStart = op.oldNo
    }
    if (op.newNo !== undefined) {
      line.newNo = op.newNo
      if (newStart === 0) newStart = op.newNo
    }
    if (op.type === "del") oldLen++
    else if (op.type === "add") newLen++
    else {
      oldLen++
      newLen++
    }
    lines.push(line)
  }
  return {
    oldStart,
    oldLength: oldLen,
    newStart,
    newLength: newLen,
    lines,
  }
}

/** Produce unified-diff hunks for an old→new pair. `[]` when input is too large or identical. */
export function produceUnifiedHunks(
  oldStr: string,
  newStr: string,
  contextLines: number = DEFAULT_CONTEXT_LINES
): DiffHunk[] {
  if (oldStr.length > MAX_DIFF_BYTES || newStr.length > MAX_DIFF_BYTES) return []
  if (oldStr === newStr) return []
  const a = oldStr.length === 0 ? [] : oldStr.split("\n")
  const b = newStr.length === 0 ? [] : newStr.split("\n")
  if (a.length === 0 && b.length === 0) return []
  return groupIntoHunks(lcsDiff(a, b), Math.max(0, contextLines))
}

/** Count added/removed lines across a set of hunks. */
export function countDiffStats(hunks: DiffHunk[]): DiffStats {
  let added = 0
  let removed = 0
  for (const h of hunks) {
    for (const line of h.lines) {
      if (line.kind === "add") added++
      else if (line.kind === "del") removed++
    }
  }
  return { added, removed }
}

/**
 * Rough line-count delta used when the LCS pass was skipped (input too
 * large). Treats the change as a full replace: every old line removed,
 * every new line added. Not a real diff, but keeps the card's `+N −M`
 * honest about magnitude.
 */
export function fallbackStats(oldStr: string, newStr: string): DiffStats {
  const oldLines = oldStr.length === 0 ? 0 : oldStr.split("\n").length
  const newLines = newStr.length === 0 ? 0 : newStr.split("\n").length
  return { added: newLines, removed: oldLines }
}

function lineCount(s: string): number {
  return s.length === 0 ? 0 : s.split("\n").length
}

/** Render hunks as a plain unified-diff text block (`--- a/path` / `@@ ... @@` / `+`/`-` lines). */
export function diffHunksToUnifiedText(
  hunks: DiffHunk[],
  filePath: string,
  maxLines: number = 30
): { text: string; truncated: number } {
  const path = filePath ?? "file"
  const out: string[] = [`--- a/${path}`, `+++ b/${path}`]
  let emitted = 0
  let truncated = 0
  for (const h of hunks) {
    if (emitted >= maxLines) {
      truncated += h.lines.length
      continue
    }
    out.push(`@@ -${h.oldStart},${h.oldLength} +${h.newStart},${h.newLength} @@`)
    for (const line of h.lines) {
      if (emitted >= maxLines) {
        truncated++
        continue
      }
      const prefix = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "
      out.push(`${prefix}${line.text}`)
      emitted++
    }
  }
  return { text: out.join("\n"), truncated }
}

/** The kind of file edit a tool performed, or `null` for non-edit tools. */
export type EditToolKind = "edit" | "write" | "multiedit" | null

export interface EditExtraction {
  kind: EditToolKind
  filePath: string | undefined
  hunks: DiffHunk[]
  stats: DiffStats
  /** True when the input was above `MAX_DIFF_BYTES` and the LCS pass was skipped. */
  tooLarge: boolean
}

/**
 * Detect an edit/write/multi-edit tool call and extract its unified-diff
 * hunks + line stats. Mirrors the field aliases the CLI's `formatEditDiff`
 * reads (`file_path`/`filePath`/`path`, `old_string`/`new_string`,
 * `edits[]`, `content`/`contents`). Returns `kind: null` for any tool that
 * isn't a file edit so the caller can ignore it.
 *
 * v1 limitation: a MultiEdit's `edits[]` are diffed INDEPENDENTLY (each
 * edit's old→new in isolation), so the 2nd+ hunk's line numbers are local
 * to that edit, not globally re-based against the cumulative file state.
 * The aggregate `stats` (+N −M) is still correct because it sums per-edit
 * deltas; only the `@@ ... @@` headers of later hunks are approximate.
 */
export function extractEditInput(toolName: string, input: Record<string, unknown>): EditExtraction {
  const name = toolName.toLowerCase()
  const filePath = readFilePath(input)
  const empty: EditExtraction = {
    kind: null,
    filePath,
    hunks: [],
    stats: { added: 0, removed: 0 },
    tooLarge: false,
  }
  if (!filePath) return empty

  if (name === "write" || name === "create") {
    const content = str(input.content, input.contents) ?? ""
    const hunks = produceUnifiedHunks("", content)
    const tooLarge = content.length > MAX_DIFF_BYTES
    const stats = tooLarge ? fallbackStats("", content) : { added: lineCount(content), removed: 0 }
    return { kind: "write", filePath, hunks, stats, tooLarge }
  }

  if (name === "multi_edit" || name === "multiedit") {
    const edits = Array.isArray(input.edits) ? input.edits : []
    const hunks: DiffHunk[] = []
    let added = 0
    let removed = 0
    let tooLarge = false
    for (const edit of edits) {
      if (!edit || typeof edit !== "object") continue
      const e = edit as Record<string, unknown>
      const oldS = str(e.old_string, e.oldString) ?? ""
      const newS = str(e.new_string, e.newString) ?? ""
      if (oldS.length > MAX_DIFF_BYTES || newS.length > MAX_DIFF_BYTES) {
        tooLarge = true
        const fs = fallbackStats(oldS, newS)
        added += fs.added
        removed += fs.removed
        continue
      }
      const hs = produceUnifiedHunks(oldS, newS)
      hunks.push(...hs)
      const st = countDiffStats(hs)
      added += st.added
      removed += st.removed
    }
    return { kind: "multiedit", filePath, hunks, stats: { added, removed }, tooLarge }
  }

  if (name === "edit" || name === "str_replace" || name === "replace") {
    const oldS = str(input.old_string, input.oldString) ?? ""
    const newS = str(input.new_string, input.newString) ?? ""
    const tooLarge = oldS.length > MAX_DIFF_BYTES || newS.length > MAX_DIFF_BYTES
    if (tooLarge) {
      return { kind: "edit", filePath, hunks: [], stats: fallbackStats(oldS, newS), tooLarge: true }
    }
    const hunks = produceUnifiedHunks(oldS, newS)
    return { kind: "edit", filePath, hunks, stats: countDiffStats(hunks), tooLarge: false }
  }

  return empty
}

/** True when `toolName` is one of the recognized file-editing tools. */
export function isFileEditTool(toolName: string): boolean {
  const name = toolName.toLowerCase()
  return (
    name === "write" ||
    name === "create" ||
    name === "edit" ||
    name === "str_replace" ||
    name === "replace" ||
    name === "multi_edit" ||
    name === "multiedit"
  )
}
