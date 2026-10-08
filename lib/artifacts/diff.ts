/**
 * Line diff for artifact / canvas version comparison and review proposals.
 *
 * Myers' O(ND) algorithm in its linear-space form (the "middle snake"
 * divide-and-conquer from Myers 1986, §4b), which is also what git's xdiff and
 * jsdiff build on. The LCS table this replaced was O(m·n) in time *and*
 * memory, prepended every result line with `unshift` (quadratic again), and
 * gave up above a million cells by reporting the whole file as removed and
 * re-added, so two identical 1,001-line versions read as a full rewrite.
 *
 * What keeps it cheap on real input:
 * - The common prefix and suffix are matched before any search, so a one-line
 *   edit in a 20,000-line file costs a scan, not a diff.
 * - Lines are interned to integers once, so the inner loop compares numbers.
 * - The recursion is an explicit work stack: an edit script with tens of
 *   thousands of changes cannot overflow the JS call stack.
 * - A work budget bounds the worst case (two unrelated large files). When one
 *   range exhausts it, only THAT range is reported as removed-then-added; the
 *   ranges already resolved around it keep their exact alignment.
 *
 * Within every changed region the removed lines come first, then the added
 * ones — the order every renderer here (and `canvas-review`) expects.
 */

import type { DiffLine, DiffStats } from "@/types"

/**
 * Default ceiling on inner-loop steps for one `computeDiff` call. Each step is
 * a couple of integer compares, so this is on the order of 100ms of main-thread
 * time on a mid-range laptop — well past any real edit, well short of a hang.
 */
export const DEFAULT_DIFF_BUDGET = 20_000_000

export interface ComputeDiffOptions {
  /** Inner-loop step ceiling; see {@link DEFAULT_DIFF_BUDGET}. */
  budget?: number
  /** Treat lines that differ only in leading / trailing whitespace as equal. */
  ignoreTrimWhitespace?: boolean
}

interface Snake {
  /** Start of the diagonal run, in absolute old / new line indices. */
  x: number
  y: number
  /** End (exclusive) of the diagonal run. */
  u: number
  v: number
}

type Task =
  | { kind: "range"; aLo: number; aHi: number; bLo: number; bHi: number }
  | { kind: "equal"; a: number; b: number; len: number }

/** Map every distinct line to a small integer shared by both sides. */
function intern(oldLines: string[], newLines: string[]): [Int32Array, Int32Array] {
  const ids = new Map<string, number>()
  const encode = (lines: string[]) => {
    const out = new Int32Array(lines.length)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      let id = ids.get(line)
      if (id === undefined) {
        id = ids.size
        ids.set(line, id)
      }
      out[i] = id
    }
    return out
  }
  return [encode(oldLines), encode(newLines)]
}

/**
 * Collects the edit script in order and normalises every changed region to
 * "all removals, then all additions" before the next unchanged line.
 */
class Emitter {
  readonly out: DiffLine[] = []
  private removed: number[] = []
  private added: number[] = []

  constructor(
    private readonly oldLines: string[],
    private readonly newLines: string[]
  ) {}

  remove(a: number) {
    this.removed.push(a)
  }

  add(b: number) {
    this.added.push(b)
  }

  equal(a: number, b: number) {
    this.flush()
    this.out.push({
      type: "unchanged",
      // The new side: identical to the old one unless whitespace is ignored,
      // where the reader should see the line as it is now.
      content: this.newLines[b],
      oldLineNum: a + 1,
      newLineNum: b + 1,
    })
  }

  flush() {
    for (const a of this.removed) {
      this.out.push({ type: "removed", content: this.oldLines[a], oldLineNum: a + 1 })
    }
    for (const b of this.added) {
      this.out.push({ type: "added", content: this.newLines[b], newLineNum: b + 1 })
    }
    this.removed = []
    this.added = []
  }
}

/**
 * Find the middle snake of `A[aLo, aHi) × B[bLo, bHi)`, or `null` once the
 * remaining budget is spent. Both ranges are non-empty and already stripped of
 * their common prefix and suffix. `vf` / `vb` are caller-owned scratch buffers
 * at least `2 * ceil((N + M) / 2) + 2` long.
 */
function middleSnake(
  A: Int32Array,
  B: Int32Array,
  aLo: number,
  aHi: number,
  bLo: number,
  bHi: number,
  vf: Int32Array,
  vb: Int32Array,
  budget: { left: number }
): Snake | null {
  const N = aHi - aLo
  const M = bHi - bLo
  const max = Math.ceil((N + M) / 2)
  const offset = max + 1
  const delta = N - M
  const odd = (delta & 1) !== 0
  vf[offset + 1] = 0
  vb[offset + 1] = 0

  for (let d = 0; d <= max; d++) {
    // Forward pass over diagonals k = x - y.
    for (let k = -d; k <= d; k += 2) {
      const i = offset + k
      let x = k === -d || (k !== d && vf[i - 1] < vf[i + 1]) ? vf[i + 1] : vf[i - 1] + 1
      let y = x - k
      const x0 = x
      const y0 = y
      while (x < N && y < M && A[aLo + x] === B[bLo + y]) {
        x++
        y++
      }
      vf[i] = x
      budget.left -= 1 + (x - x0)
      if (odd) {
        // The backward pass has completed d - 1 steps; its diagonal for this
        // forward diagonal is delta - k.
        const kb = delta - k
        if (kb >= -(d - 1) && kb <= d - 1 && x + vb[offset + kb] >= N) {
          return { x: aLo + x0, y: bLo + y0, u: aLo + x, v: bLo + y }
        }
      }
    }
    // Backward pass, in reversed coordinates (x' counts lines from the end).
    for (let kb = -d; kb <= d; kb += 2) {
      const i = offset + kb
      let x = kb === -d || (kb !== d && vb[i - 1] < vb[i + 1]) ? vb[i + 1] : vb[i - 1] + 1
      let y = x - kb
      const x0 = x
      const y0 = y
      while (x < N && y < M && A[aHi - 1 - x] === B[bHi - 1 - y]) {
        x++
        y++
      }
      vb[i] = x
      budget.left -= 1 + (x - x0)
      if (!odd) {
        const k = delta - kb
        if (k >= -d && k <= d && vf[offset + k] + x >= N) {
          return { x: aLo + N - x, y: bLo + M - y, u: aLo + N - x0, v: bLo + M - y0 }
        }
      }
    }
    if (budget.left <= 0) return null
  }
  // Unreachable for non-empty ranges: the two searches always meet by `max`.
  return null
}

/**
 * Compute a line-based diff of `oldText` → `newText`.
 *
 * Line numbers are 1-based. Splits on `\n` exactly as before, so a trailing
 * newline yields a trailing empty line on that side. An empty text has no
 * lines at all: a created file is all additions, not an empty line replaced.
 *
 * `ignoreTrimWhitespace` compares lines with leading and trailing whitespace
 * removed (Monaco's option of the same name), so a re-indent reads as
 * unchanged; such a line shows its new-side text.
 */
export function computeDiff(
  oldText: string,
  newText: string,
  options: ComputeDiffOptions = {}
): DiffLine[] {
  const oldLines = oldText === "" ? [] : oldText.split("\n")
  const newLines = newText === "" ? [] : newText.split("\n")
  const ignoreWs = options.ignoreTrimWhitespace === true
  const oldKeys = ignoreWs ? oldLines.map((l) => l.trim()) : oldLines
  const newKeys = ignoreWs ? newLines.map((l) => l.trim()) : newLines
  const emit = new Emitter(oldLines, newLines)

  // Common prefix / suffix on the raw strings, before paying for interning.
  let start = 0
  const minLen = Math.min(oldLines.length, newLines.length)
  while (start < minLen && oldKeys[start] === newKeys[start]) start++
  let oldEnd = oldLines.length
  let newEnd = newLines.length
  while (oldEnd > start && newEnd > start && oldKeys[oldEnd - 1] === newKeys[newEnd - 1]) {
    oldEnd--
    newEnd--
  }
  for (let i = 0; i < start; i++) emit.equal(i, i)

  if (start < oldEnd || start < newEnd) {
    const [A, B] = intern(oldKeys, newKeys)
    const scratchLen = 2 * Math.ceil((oldEnd - start + (newEnd - start)) / 2) + 2
    const vf = new Int32Array(scratchLen)
    const vb = new Int32Array(scratchLen)
    const budget = { left: options.budget ?? DEFAULT_DIFF_BUDGET }

    const stack: Task[] = [{ kind: "range", aLo: start, aHi: oldEnd, bLo: start, bHi: newEnd }]
    while (stack.length > 0) {
      const task = stack.pop()!
      if (task.kind === "equal") {
        for (let i = 0; i < task.len; i++) emit.equal(task.a + i, task.b + i)
        continue
      }
      let { aLo, aHi, bLo, bHi } = task
      while (aLo < aHi && bLo < bHi && A[aLo] === B[bLo]) {
        emit.equal(aLo, bLo)
        aLo++
        bLo++
      }
      let suffix = 0
      while (aHi > aLo && bHi > bLo && A[aHi - 1] === B[bHi - 1]) {
        aHi--
        bHi--
        suffix++
      }
      // Pushed first so it runs after everything inside this range.
      if (suffix > 0) stack.push({ kind: "equal", a: aHi, b: bHi, len: suffix })

      if (aLo === aHi || bLo === bHi) {
        for (let a = aLo; a < aHi; a++) emit.remove(a)
        for (let b = bLo; b < bHi; b++) emit.add(b)
        continue
      }

      const snake = budget.left > 0 ? middleSnake(A, B, aLo, aHi, bLo, bHi, vf, vb, budget) : null
      const whole = aHi - aLo + (bHi - bLo)
      const left = snake ? snake.x - aLo + (snake.y - bLo) : 0
      const right = snake ? aHi - snake.u + (bHi - snake.v) : 0
      // Out of budget, or a split that would not shrink the problem (a guard,
      // not an expected path): report this range alone as a replacement.
      if (!snake || left >= whole || right >= whole) {
        for (let a = aLo; a < aHi; a++) emit.remove(a)
        for (let b = bLo; b < bHi; b++) emit.add(b)
        continue
      }
      // LIFO: push in reverse of the order the pieces must be emitted.
      stack.push({ kind: "range", aLo: snake.u, aHi, bLo: snake.v, bHi })
      if (snake.u > snake.x) {
        stack.push({ kind: "equal", a: snake.x, b: snake.y, len: snake.u - snake.x })
      }
      stack.push({ kind: "range", aLo, aHi: snake.x, bLo, bHi: snake.y })
    }
  }

  for (let i = 0; i < oldLines.length - oldEnd; i++) emit.equal(oldEnd + i, newEnd + i)
  emit.flush()
  return emit.out
}

/**
 * Compute diff statistics from a diff result
 */
export function computeDiffStats(diff: DiffLine[]): DiffStats {
  let added = 0
  let removed = 0
  for (const line of diff) {
    if (line.type === "added") added++
    if (line.type === "removed") removed++
  }
  return { added, removed }
}

/**
 * One row of a rendered line diff: a line, a run of hidden unchanged lines
 * the reader can expand, or a fixed section header (a git hunk's `@@` line,
 * where the lines between hunks were never loaded and cannot be expanded).
 */
export type DiffRow =
  | { kind: "line"; line: DiffLine; index: number }
  | {
      kind: "gap"
      /** Index of the first hidden line in the source `DiffLine[]`. */
      start: number
      /** Number of hidden unchanged lines. */
      count: number
    }
  | { kind: "header"; key: string; text: string }

/**
 * Fold every run of unchanged lines longer than `2 * context` into a single
 * gap row, keeping `context` lines on each side of a change (the file's head
 * and tail keep only the side that touches a change). Gaps whose `start` is in
 * `expanded` are shown in full. A diff with no changes collapses to one gap.
 */
export function collapseDiffContext(
  lines: DiffLine[],
  context: number,
  expanded: ReadonlySet<number> = new Set()
): DiffRow[] {
  const rows: DiffRow[] = []
  let i = 0
  while (i < lines.length) {
    if (lines[i].type !== "unchanged") {
      rows.push({ kind: "line", line: lines[i], index: i })
      i++
      continue
    }
    let end = i
    while (end < lines.length && lines[end].type === "unchanged") end++
    const atHead = i === 0
    const atTail = end === lines.length
    const keepBefore = atHead ? 0 : context
    const keepAfter = atTail ? 0 : context
    const hidden = end - i - keepBefore - keepAfter
    // A gap row for a single hidden line costs as much space as the line.
    if (hidden <= 1 || expanded.has(i + keepBefore)) {
      for (let j = i; j < end; j++) rows.push({ kind: "line", line: lines[j], index: j })
    } else {
      for (let j = i; j < i + keepBefore; j++) rows.push({ kind: "line", line: lines[j], index: j })
      rows.push({ kind: "gap", start: i + keepBefore, count: hidden })
      for (let j = end - keepAfter; j < end; j++) {
        rows.push({ kind: "line", line: lines[j], index: j })
      }
    }
    i = end
  }
  return rows
}

/**
 * Index into `diff` of the line numbered `line` on `side`. For a side the line
 * no longer exists on (an old line asked for on the new side), the nearest
 * line that exists on the requested side is returned: the first one after it,
 * else the last one before it. `-1` for an empty diff.
 */
export function diffIndexForLine(diff: DiffLine[], side: "old" | "new", line: number): number {
  if (diff.length === 0) return -1
  const key = side === "old" ? "oldLineNum" : "newLineNum"
  let before = -1
  for (let i = 0; i < diff.length; i++) {
    const n = diff[i][key]
    if (n === undefined) continue
    if (n >= line) return i
    before = i
  }
  return before === -1 ? 0 : before
}

/**
 * The modified-side line to scroll to for a change that starts at `oldLine`
 * on the original side (review hunks are ranged on the original). A pure
 * deletion has no new-side line of its own; it lands on the line after it.
 */
export function newLineForOldLine(diff: DiffLine[], oldLine: number): number {
  const at = diffIndexForLine(diff, "old", oldLine)
  if (at === -1) return 1
  for (let i = at; i < diff.length; i++) {
    const n = diff[i].newLineNum
    if (n !== undefined) return n
  }
  for (let i = at; i >= 0; i--) {
    const n = diff[i].newLineNum
    if (n !== undefined) return n
  }
  return 1
}
