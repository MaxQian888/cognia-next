/**
 * Vim editing mode for the composer (Claude Code parity, `/vim` to toggle).
 *
 * A pure NORMAL/REPLACE-mode key interpreter over the composer's
 * {@link InputBuffer}: the `Input` component feeds keys here and applies the
 * returned buffer/state; INSERT mode is the composer's normal behaviour (Esc
 * drops back to NORMAL via {@link enterNormalFromInsert}, sealing any pending
 * change through {@link sealVimEntry} so `.` can repeat it).
 *
 * Scoped subset (the motions/operators that matter in a one-shot composer):
 *   modes    i a I A o O · R (replace) · Esc
 *   motions  h j k l · arrows · w b e · 0 ^ $ · gg G · counts (e.g. 3w)
 *   edits    x X · dd dw de d$ D · cc cw ce c$ C S · s · yy p P
 *   search   / ? (literal match) · n N
 *   other    u (undo) · Ctrl+R (redo) · . (repeat) · Enter (submit)
 *
 * Operator+motion spans (`dw`/`ce`/…) are clamped to the current line — a
 * composer draft is a handful of lines, not a file; linewise `dd`/`cc`/`yy`
 * cover the multi-line cases. Searches match literal text, not regex.
 */
import { moveWordLeft } from "./buffer"
import type { KeyFlags } from "./keymap"
import type { InputBuffer } from "../state/types"

export type VimMode = "insert" | "normal" | "replace"

/** The last deleted/yanked text; linewise registers paste as whole lines. */
export interface VimRegister {
  text: string
  linewise: boolean
}

/** A draft search: `/` is forward, `?` is backward. */
export interface VimSearch {
  dir: "fwd" | "back"
  query: string
}

/**
 * A repeatable edit, recorded for `.`. Ops that hand off to INSERT/REPLACE for
 * their text (change/substitute/open/insert families) are stored with
 * `text: ""` while the entry is live and sealed with the captured text when
 * the user hits Esc — see {@link sealVimEntry}.
 */
export type VimChange =
  | { op: "delete-chars"; dir: 1 | -1; count: number }
  | { op: "delete-lines"; count: number }
  | { op: "delete-to-eol" }
  | { op: "delete-motion"; motion: string; count: number }
  | { op: "put"; after: boolean; register: VimRegister }
  | { op: "insert-at"; entry: "i" | "a" | "I" | "A"; text: string }
  | { op: "open-line"; below: boolean; text: string }
  | { op: "change-motion"; motion: string; count: number; text: string }
  | { op: "change-lines"; count: number; text: string }
  | { op: "change-to-eol"; text: string }
  | { op: "substitute-chars"; count: number; text: string }
  | { op: "substitute-line"; text: string }
  | { op: "replace"; text: string }

/** The subset of {@link VimChange} whose text is typed after the op lands. */
type VimTextChange = Extract<VimChange, { text: string }>

interface VimEntry {
  /** The change awaiting its typed text (`text` filled at seal). */
  change: VimTextChange
  /** `bufferText` snapshot taken right after the entry edit landed. */
  before: string
}

/** Bookkeeping for a live REPLACE session (see {@link handleVimReplaceKey}). */
interface VimReplaceSession {
  /** Column `R` started on — backspace past it only moves the cursor. */
  startCol: number
  /** The cursor line's text at session start, for backspace restore. */
  originalLine: string
  /** Chars written per column — the `.` replay text, in column order. */
  typed: Record<number, string>
}

export interface VimState {
  mode: VimMode
  /** Pending operator (`d`/`c`/`y`) or `g` prefix awaiting its motion. */
  pending: "d" | "c" | "y" | "g" | null
  /** Count prefix accumulator (digits typed so far, `""` = none). */
  count: string
  register: VimRegister | null
  /** Live INSERT entry — an op that applied its edit and is collecting text. */
  entry: VimEntry | null
  /** Last completed change — what `.` repeats. */
  lastChange: VimChange | null
  /** Live search-entry — keys feed `query` until Enter commits or Esc cancels. */
  search: VimSearch | null
  /** Last committed search — what `n`/`N` navigate. */
  lastSearch: VimSearch | null
  /** Live REPLACE session bookkeeping; null outside replace mode. */
  replace: VimReplaceSession | null
}

export function initialVimState(): VimState {
  return {
    mode: "insert",
    pending: null,
    count: "",
    register: null,
    entry: null,
    lastChange: null,
    search: null,
    lastSearch: null,
    replace: null,
  }
}

/** A side effect the composer must perform (delegated to its existing paths). */
export type VimRequest = "undo" | "redo" | "submit"

export interface VimKeyResult {
  state: VimState
  buffer: InputBuffer
  request?: VimRequest
  /** False → the key isn't vim's (control chords etc.); run the default flow. */
  handled: boolean
}

// ── Cursor / span primitives ─────────────────────────────────────────────────

/** NORMAL-mode column clamp: the cursor sits ON a character (or col 0). */
function clampCol(line: string, col: number): number {
  return Math.max(0, Math.min(col, Math.max(0, line.length - 1)))
}

function withCursor(b: InputBuffer, row: number, col: number): InputBuffer {
  const r = Math.max(0, Math.min(row, b.lines.length - 1))
  return { lines: b.lines, cursorRow: r, cursorCol: clampCol(b.lines[r], col) }
}

/** Leaving INSERT/REPLACE: vim pulls the cursor one column left (onto the
 * last-typed char). */
export function enterNormalFromInsert(b: InputBuffer): InputBuffer {
  return withCursor(b, b.cursorRow, b.cursorCol - 1)
}

function firstNonBlankCol(line: string): number {
  const m = line.match(/\S/)
  return m?.index ?? 0
}

/** Start of the NEXT word (vim `w`) — emacs' word-right stops at word END,
 * so this is implemented here rather than reusing `moveWordRight`. */
function nextWordStartCol(line: string, col: number): number {
  let i = col
  while (i < line.length && /\S/.test(line[i])) i++
  while (i < line.length && /\s/.test(line[i])) i++
  return i
}

/** End-of-word column (vim `e`): the LAST char of the current/next word. */
function wordEndCol(line: string, col: number): number {
  let i = col + 1
  while (i < line.length && /\s/.test(line[i])) i++
  if (i >= line.length) return clampCol(line, col)
  while (i + 1 < line.length && /\S/.test(line[i + 1])) i++
  return i
}

/** Delete `[start, end)` on the cursor line; returns the removed text. */
function deleteSpan(b: InputBuffer, start: number, end: number): { b: InputBuffer; cut: string } {
  const line = b.lines[b.cursorRow]
  const s = Math.max(0, Math.min(start, end))
  const e = Math.min(line.length, Math.max(start, end))
  if (s === e) return { b, cut: "" }
  const lines = [...b.lines]
  lines[b.cursorRow] = line.slice(0, s) + line.slice(e)
  return {
    b: { lines, cursorRow: b.cursorRow, cursorCol: clampCol(lines[b.cursorRow], s) },
    cut: line.slice(s, e),
  }
}

/** Delete `n` whole lines from `row`; the buffer never drops below one line. */
function deleteLines(b: InputBuffer, row: number, n: number): { b: InputBuffer; cut: string } {
  const end = Math.min(b.lines.length, row + n)
  const cut = b.lines.slice(row, end).join("\n")
  const lines = [...b.lines.slice(0, row), ...b.lines.slice(end)]
  if (lines.length === 0) lines.push("")
  const cursorRow = Math.min(row, lines.length - 1)
  return { b: { lines, cursorRow, cursorCol: firstNonBlankCol(lines[cursorRow]) }, cut }
}

/** Insert `text` (which may contain newlines) at an explicit position; the
 * cursor lands on the last inserted character, matching post-Esc NORMAL. */
function insertTextAt(b: InputBuffer, row: number, col: number, text: string): InputBuffer {
  if (text === "") return withCursor(b, row, col)
  const line = b.lines[row]
  const before = line.slice(0, col)
  const after = line.slice(col)
  const segs = text.split("\n")
  if (segs.length === 1) {
    const lines = [...b.lines]
    lines[row] = before + text + after
    return { lines, cursorRow: row, cursorCol: clampCol(lines[row], col + text.length - 1) }
  }
  const lines = [
    ...b.lines.slice(0, row),
    before + segs[0],
    ...segs.slice(1, -1),
    segs[segs.length - 1] + after,
    ...b.lines.slice(row + 1),
  ]
  const cursorRow = row + segs.length - 1
  const last = segs[segs.length - 1]
  return {
    lines,
    cursorRow,
    cursorCol: clampCol(lines[cursorRow], Math.max(0, last.length - 1)),
  }
}

/** Resolve a charwise motion to its span end (exclusive) on the cursor line. */
function motionSpanEnd(b: InputBuffer, motion: string, count: number): number | null {
  const line = b.lines[b.cursorRow]
  let col = b.cursorCol
  switch (motion) {
    case "w": {
      let col = b.cursorCol
      for (let i = 0; i < count; i++) col = nextWordStartCol(line, col)
      return col // already clamped to the line by construction
    }
    case "e": {
      for (let i = 0; i < count; i++) col = wordEndCol(line, col)
      return Math.min(line.length, col + 1) // include the end char
    }
    case "$":
      return line.length
    default:
      return null
  }
}

/** Resolve a backwards charwise motion to its span start on the cursor line. */
function motionSpanStart(b: InputBuffer, motion: string, count: number): number | null {
  switch (motion) {
    case "b": {
      let probe: InputBuffer = b
      for (let i = 0; i < count; i++) probe = moveWordLeft(probe)
      return probe.cursorRow === b.cursorRow ? probe.cursorCol : 0
    }
    case "0":
      return 0
    default:
      return null
  }
}

// ── Search ───────────────────────────────────────────────────────────────────

/** Every (row, start, end) literal-match range for `query` across the buffer. */
export function vimSearchMatches(
  lines: string[],
  query: string
): Array<{ row: number; start: number; end: number }> {
  if (query === "") return []
  const out: Array<{ row: number; start: number; end: number }> = []
  lines.forEach((line, row) => {
    let idx = line.indexOf(query)
    while (idx >= 0) {
      out.push({ row, start: idx, end: idx + query.length })
      idx = line.indexOf(query, idx + 1)
    }
  })
  return out
}

/**
 * The next match from the cursor in the search direction, wrapping at the
 * ends like vim. With `inclusive` a match starting AT the cursor counts —
 * that's incsearch's "find the first match from here". Without it (the `n`/`N`
 * and empty-query replay paths) the match under the cursor is skipped.
 * Null when the query matches nothing.
 */
export function nextVimSearchMatch(
  b: InputBuffer,
  search: VimSearch,
  opts: { inclusive?: boolean } = {}
): { row: number; col: number } | null {
  const matches = vimSearchMatches(b.lines, search.query)
  if (matches.length === 0) return null
  const after = (m: { row: number; start: number }) =>
    m.row > b.cursorRow ||
    (m.row === b.cursorRow && (opts.inclusive ? m.start >= b.cursorCol : m.start > b.cursorCol))
  const before = (m: { row: number; start: number }) =>
    m.row < b.cursorRow ||
    (m.row === b.cursorRow && (opts.inclusive ? m.start <= b.cursorCol : m.start < b.cursorCol))
  const hit =
    search.dir === "fwd"
      ? (matches.find(after) ?? matches[0])
      : ([...matches].reverse().find(before) ?? matches[matches.length - 1])
  return { row: hit.row, col: hit.start }
}

/**
 * The text inserted between two buffer snapshots — the common prefix/suffix
 * diff. Used to seal an INSERT entry's change for `.`. Deletions the user made
 * mid-insert are not captured (the diff can only report net inserted text).
 */
export function insertedTextBetween(before: string, after: string): string {
  let pre = 0
  const max = Math.min(before.length, after.length)
  while (pre < max && before[pre] === after[pre]) pre++
  let suf = 0
  while (suf < max - pre && before[before.length - 1 - suf] === after[after.length - 1 - suf]) {
    suf++
  }
  return after.slice(pre, after.length - suf)
}

/**
 * Seal a live INSERT entry into `lastChange`. Called by the composer when Esc
 * drops INSERT → NORMAL; the buffer is the one the user finished typing into.
 * No-op when the insert session wasn't a repeatable entry (e.g. the composer's
 * initial INSERT mode).
 */
export function sealVimEntry(state: VimState, buffer: InputBuffer): VimState {
  if (!state.entry) return state
  const text = insertedTextBetween(state.entry.before, buffer.lines.join("\n"))
  return { ...state, entry: null, lastChange: { ...state.entry.change, text } }
}

// ── The key interpreters ─────────────────────────────────────────────────────

const cleared = (s: VimState): VimState => ({ ...s, pending: null, count: "" })
const toInsert = (s: VimState, change: VimTextChange, b: InputBuffer): VimState => ({
  ...cleared(s),
  mode: "insert",
  entry: { change, before: b.lines.join("\n") },
})

/**
 * Interpret one REPLACE-mode key. Typed characters overwrite the character
 * under the cursor (appending past end-of-line); Backspace restores the
 * overwritten character; Esc seals the session as a `.`-repeatable change and
 * drops to NORMAL; Enter submits.
 */
export function handleVimReplaceKey(
  input: string,
  key: KeyFlags,
  state: VimState,
  buffer: InputBuffer
): VimKeyResult {
  const done = (s: VimState, b: InputBuffer, request?: VimRequest): VimKeyResult => ({
    state: s,
    buffer: b,
    request,
    handled: true,
  })
  const b = buffer
  const line = b.lines[b.cursorRow]
  const sess = state.replace ?? {
    startCol: b.cursorCol,
    originalLine: line,
    typed: {} as Record<number, string>,
  }

  if (key.escape) {
    const typed = Object.keys(sess.typed)
      .map(Number)
      .sort((x, y) => x - y)
      .map((col) => sess.typed[col])
      .join("")
    return done(
      {
        ...state,
        mode: "normal",
        pending: null,
        count: "",
        replace: null,
        lastChange: typed === "" ? state.lastChange : { op: "replace", text: typed },
      },
      enterNormalFromInsert(b)
    )
  }
  if (key.return) return done(state, b, "submit")
  if (key.ctrl || key.meta) return { state, buffer: b, handled: false }
  if (key.backspace || key.delete) {
    if (b.cursorCol > sess.startCol) {
      // Restore the char this session overwrote (or drop the appended one).
      const col = b.cursorCol - 1
      const orig = col < sess.originalLine.length ? sess.originalLine[col] : ""
      const lines = [...b.lines]
      lines[b.cursorRow] = line.slice(0, col) + orig + line.slice(col + 1)
      const typed = { ...sess.typed }
      delete typed[col]
      return done(
        { ...state, replace: { ...sess, typed } },
        { lines, cursorRow: b.cursorRow, cursorCol: col }
      )
    }
    return done(state, withCursor(b, b.cursorRow, b.cursorCol - 1))
  }
  if (key.leftArrow) return done(state, withCursor(b, b.cursorRow, b.cursorCol - 1))
  if (key.rightArrow) return done(state, withCursor(b, b.cursorRow, b.cursorCol + 1))
  if (key.upArrow) return done(state, withCursor(b, b.cursorRow - 1, b.cursorCol))
  if (key.downArrow) return done(state, withCursor(b, b.cursorRow + 1, b.cursorCol))
  if (!input) return done(state, b)

  // Overwrite `input` starting at the cursor; past EOL the tail appends.
  const col = b.cursorCol
  const lines = [...b.lines]
  lines[b.cursorRow] = line.slice(0, col) + input + line.slice(col + input.length)
  const typed = { ...sess.typed }
  for (let i = 0; i < input.length; i++) typed[col + i] = input[i]
  return done(
    { ...state, replace: { ...sess, typed } },
    { lines, cursorRow: b.cursorRow, cursorCol: col + input.length }
  )
}

/** Replay `state.lastChange` against the buffer (the `.` command). The whole
 * change applies atomically and stays in NORMAL — including the captured
 * insert/replace text. */
function replayVimChange(state: VimState, b: InputBuffer): VimKeyResult {
  const done = (next: InputBuffer): VimKeyResult => ({
    state: { ...state, pending: null, count: "" },
    buffer: next,
    handled: true,
  })
  const ch = state.lastChange
  if (!ch) return { state: cleared(state), buffer: b, handled: true }
  const line = b.lines[b.cursorRow]
  switch (ch.op) {
    case "delete-chars": {
      const s = ch.dir === 1 ? b.cursorCol : b.cursorCol - ch.count
      const e = ch.dir === 1 ? b.cursorCol + ch.count : b.cursorCol
      return done(deleteSpan(b, s, e).b)
    }
    case "delete-lines":
      return done(deleteLines(b, b.cursorRow, ch.count).b)
    case "delete-to-eol":
      return done(deleteSpan(b, b.cursorCol, line.length).b)
    case "delete-motion": {
      const end = motionSpanEnd(b, ch.motion, ch.count)
      const start = motionSpanStart(b, ch.motion, ch.count)
      if (end === null && start === null) return done(b)
      return done(deleteSpan(b, start ?? b.cursorCol, end ?? b.cursorCol).b)
    }
    case "put": {
      const reg = ch.register
      if (reg.linewise) {
        const at = ch.after ? b.cursorRow + 1 : b.cursorRow
        const lines = [...b.lines.slice(0, at), ...reg.text.split("\n"), ...b.lines.slice(at)]
        return done({
          lines,
          cursorRow: at,
          cursorCol: firstNonBlankCol(reg.text.split("\n")[0]),
        })
      }
      const at = ch.after ? Math.min(line.length, b.cursorCol + 1) : b.cursorCol
      const lines = [...b.lines]
      lines[b.cursorRow] = line.slice(0, at) + reg.text + line.slice(at)
      return done({
        lines,
        cursorRow: b.cursorRow,
        cursorCol: clampCol(lines[b.cursorRow], at + reg.text.length - 1),
      })
    }
    case "insert-at": {
      const col =
        ch.entry === "i"
          ? b.cursorCol
          : ch.entry === "a"
            ? Math.min(line.length, b.cursorCol + 1)
            : ch.entry === "I"
              ? firstNonBlankCol(line)
              : line.length
      return done(insertTextAt(b, b.cursorRow, col, ch.text))
    }
    case "open-line": {
      const row = ch.below ? b.cursorRow + 1 : b.cursorRow
      const lines = [...b.lines.slice(0, row), "", ...b.lines.slice(row)]
      return done(insertTextAt({ ...b, lines }, row, 0, ch.text))
    }
    case "change-motion": {
      const end = motionSpanEnd(b, ch.motion, ch.count)
      const start = motionSpanStart(b, ch.motion, ch.count)
      if (end === null && start === null) return done(b)
      const s = start ?? b.cursorCol
      const { b: next } = deleteSpan(b, s, end ?? b.cursorCol)
      return done(
        insertTextAt(next, next.cursorRow, Math.min(s, next.lines[next.cursorRow].length), ch.text)
      )
    }
    case "change-lines": {
      const { b: next } = deleteLines(b, b.cursorRow, ch.count)
      // Same guard as the `cc` op: a fully-deleted buffer stays a single
      // empty line — no extra splice.
      if (next.lines.length === 1 && next.lines[0] === "") {
        return done(insertTextAt(next, 0, 0, ch.text))
      }
      const row = Math.min(b.cursorRow, next.lines.length - 1)
      const lines = [...next.lines.slice(0, row), "", ...next.lines.slice(row)]
      return done(insertTextAt({ ...next, lines }, row, 0, ch.text))
    }
    case "change-to-eol": {
      const { b: next } = deleteSpan(b, b.cursorCol, line.length)
      return done(insertTextAt(next, next.cursorRow, next.cursorCol, ch.text))
    }
    case "substitute-chars": {
      const { b: next } = deleteSpan(b, b.cursorCol, b.cursorCol + ch.count)
      return done(insertTextAt(next, next.cursorRow, next.cursorCol, ch.text))
    }
    case "substitute-line": {
      const lines = [...b.lines]
      lines[b.cursorRow] = ""
      return done(insertTextAt({ ...b, lines }, b.cursorRow, 0, ch.text))
    }
    case "replace": {
      const lines = [...b.lines]
      lines[b.cursorRow] =
        line.slice(0, b.cursorCol) + ch.text + line.slice(b.cursorCol + ch.text.length)
      return done({
        lines,
        cursorRow: b.cursorRow,
        cursorCol: clampCol(lines[b.cursorRow], b.cursorCol + ch.text.length - 1),
      })
    }
  }
}

/**
 * Interpret one NORMAL-mode key. Pure: returns the next vim state, the next
 * buffer, and any request the composer should run through its existing paths
 * (undo/redo/submit). `handled: false` hands control chords and other
 * non-vim keys back to the default composer flow.
 */
export function handleVimNormalKey(
  input: string,
  key: KeyFlags,
  state: VimState,
  buffer: InputBuffer
): VimKeyResult {
  const done = (s: VimState, b: InputBuffer, request?: VimRequest): VimKeyResult => ({
    state: s,
    buffer: b,
    request,
    handled: true,
  })
  const b = buffer
  const line = b.lines[b.cursorRow]
  const count = state.count === "" ? 1 : Math.max(1, parseInt(state.count, 10))

  // A live search-entry owns the keyboard until Enter commits or Esc cancels.
  if (state.search) {
    if (key.escape) return done({ ...state, search: null }, b)
    if (key.return) {
      // `/`+Enter on an empty query repeats the previous search (vim parity);
      // with a live query the cursor already sits on the incremental hit.
      const prior = state.lastSearch
      const empty = state.search.query === ""
      const committed = empty && prior ? prior : state.search
      const st = { ...state, search: null, lastSearch: committed }
      const hit = empty && prior ? nextVimSearchMatch(b, prior) : null
      return done(st, hit ? { ...b, cursorRow: hit.row, cursorCol: hit.col } : b)
    }
    if (key.ctrl || key.meta) return { state, buffer: b, handled: false }
    if (key.backspace || key.delete) {
      const search = { ...state.search, query: state.search.query.slice(0, -1) }
      const hit = search.query === "" ? null : nextVimSearchMatch(b, search, { inclusive: true })
      return done({ ...state, search }, hit ? { ...b, cursorRow: hit.row, cursorCol: hit.col } : b)
    }
    if (!input) return done(state, b)
    // Incremental search: each typed char jumps to the first match from here.
    const search = { ...state.search, query: state.search.query + input }
    const hit = nextVimSearchMatch(b, search, { inclusive: true })
    return done({ ...state, search }, hit ? { ...b, cursorRow: hit.row, cursorCol: hit.col } : b)
  }

  // Enter submits from NORMAL too — the composer is still a prompt box.
  if (key.return) return done(cleared(state), b, "submit")
  // Esc clears a pending operator/count; with nothing pending it's a no-op
  // (the App's global Esc behaviours only fire while the turn is busy).
  if (key.escape) return done(cleared(state), b)
  // Ctrl+R = redo; every other control chord belongs to the default flow
  // (rebindable app chords like Ctrl+F/Ctrl+R-history are gated off in vim's
  // NORMAL mode only for plain keys).
  if (key.ctrl || key.meta) {
    if (key.ctrl && input === "r") return done(cleared(state), b, "redo")
    return { state, buffer: b, handled: false }
  }
  // Arrows move like h/j/k/l (shared clamp).
  if (key.leftArrow) return done(cleared(state), withCursor(b, b.cursorRow, b.cursorCol - count))
  if (key.rightArrow) return done(cleared(state), withCursor(b, b.cursorRow, b.cursorCol + count))
  if (key.upArrow) return done(cleared(state), withCursor(b, b.cursorRow - count, b.cursorCol))
  if (key.downArrow) return done(cleared(state), withCursor(b, b.cursorRow + count, b.cursorCol))
  // Backspace = move left (vim NORMAL never deletes on backspace).
  if (key.backspace || key.delete)
    return done(cleared(state), withCursor(b, b.cursorRow, b.cursorCol - 1))
  if (!input) return done(state, b)

  const ch = input[0]

  // Count prefix: 1-9 always; 0 only continues an existing count (else motion).
  if (/[1-9]/.test(ch) || (ch === "0" && state.count !== "")) {
    return done({ ...state, count: state.count + ch }, b)
  }

  // `g` prefix → `gg` (go to line `count`, default first).
  if (state.pending === "g") {
    if (ch === "g") {
      const row = state.count === "" ? 0 : count - 1
      return done(
        cleared(state),
        withCursor(
          b,
          row,
          firstNonBlankCol(b.lines[Math.max(0, Math.min(row, b.lines.length - 1))])
        )
      )
    }
    return done(cleared(state), b)
  }

  // Operator pending → resolve its motion (or the doubled linewise form).
  if (state.pending === "d" || state.pending === "c" || state.pending === "y") {
    const op = state.pending
    if (ch === op) {
      // dd / cc / yy — linewise on `count` lines.
      if (op === "y") {
        const cut = b.lines.slice(b.cursorRow, b.cursorRow + count).join("\n")
        return done({ ...cleared(state), register: { text: cut, linewise: true } }, b)
      }
      const { b: next, cut } = deleteLines(b, b.cursorRow, count)
      const reg = { text: cut, linewise: true }
      if (op === "c") {
        // cc: reopen an empty line in place and insert. The entry snapshot is
        // the REOPENED buffer — that's the text the user types into.
        const lines = [...next.lines.slice(0, b.cursorRow), "", ...next.lines.slice(b.cursorRow)]
        const reopened =
          next.lines.length === 1 && next.lines[0] === ""
            ? next
            : { lines, cursorRow: b.cursorRow, cursorCol: 0 }
        const change: VimTextChange = { op: "change-lines", count, text: "" }
        return {
          state: { ...toInsert(state, change, reopened), register: reg },
          buffer: { ...reopened, cursorCol: 0 },
          handled: true,
        }
      }
      // dd
      return done(
        {
          ...cleared(state),
          register: reg,
          lastChange: { op: "delete-lines", count },
        },
        next
      )
    }
    const end = motionSpanEnd(b, ch, count)
    const start = motionSpanStart(b, ch, count)
    if (end !== null || start !== null) {
      const s = start ?? b.cursorCol
      const e = end ?? b.cursorCol
      if (op === "y") {
        const [lo, hi] = s <= e ? [s, e] : [e, s]
        return done(
          { ...cleared(state), register: { text: line.slice(lo, hi), linewise: false } },
          b
        )
      }
      const { b: next, cut } = deleteSpan(b, s, e)
      if (op === "c") {
        const change: VimTextChange = { op: "change-motion", motion: ch, count, text: "" }
        const st = {
          ...toInsert(state, change, next),
          register: { text: cut, linewise: false },
        }
        // `c` leaves the cursor where the span began, ready to type (col may sit
        // one past the last char, which INSERT mode allows).
        const buf = { ...next, cursorCol: Math.min(s, next.lines[next.cursorRow].length) }
        return { state: st, buffer: buf, handled: true }
      }
      // d<motion>
      return done(
        {
          ...cleared(state),
          register: { text: cut, linewise: false },
          lastChange: { op: "delete-motion", motion: ch, count },
        },
        next
      )
    }
    return done(cleared(state), b) // unknown motion — drop the operator
  }

  switch (ch) {
    // ── mode changes ──
    case "i": {
      const change: VimTextChange = { op: "insert-at", entry: "i", text: "" }
      return { state: toInsert(state, change, b), buffer: b, handled: true }
    }
    case "a": {
      const change: VimTextChange = { op: "insert-at", entry: "a", text: "" }
      return {
        state: toInsert(state, change, b),
        buffer: { ...b, cursorCol: Math.min(line.length, b.cursorCol + 1) },
        handled: true,
      }
    }
    case "I": {
      const change: VimTextChange = { op: "insert-at", entry: "I", text: "" }
      return {
        state: toInsert(state, change, b),
        buffer: { ...b, cursorCol: firstNonBlankCol(line) },
        handled: true,
      }
    }
    case "A": {
      const change: VimTextChange = { op: "insert-at", entry: "A", text: "" }
      return {
        state: toInsert(state, change, b),
        buffer: { ...b, cursorCol: line.length },
        handled: true,
      }
    }
    case "o": {
      const lines = [...b.lines.slice(0, b.cursorRow + 1), "", ...b.lines.slice(b.cursorRow + 1)]
      const next = { lines, cursorRow: b.cursorRow + 1, cursorCol: 0 }
      const change: VimTextChange = { op: "open-line", below: true, text: "" }
      return { state: toInsert(state, change, next), buffer: next, handled: true }
    }
    case "O": {
      const lines = [...b.lines.slice(0, b.cursorRow), "", ...b.lines.slice(b.cursorRow)]
      const next = { lines, cursorRow: b.cursorRow, cursorCol: 0 }
      const change: VimTextChange = { op: "open-line", below: false, text: "" }
      return { state: toInsert(state, change, next), buffer: next, handled: true }
    }
    case "R":
      return done(
        {
          ...cleared(state),
          mode: "replace",
          replace: { startCol: b.cursorCol, originalLine: line, typed: {} },
        },
        b
      )

    // ── motions ──
    case "h":
      return done(cleared(state), withCursor(b, b.cursorRow, b.cursorCol - count))
    case "l":
      return done(cleared(state), withCursor(b, b.cursorRow, b.cursorCol + count))
    case "k":
      return done(cleared(state), withCursor(b, b.cursorRow - count, b.cursorCol))
    case "j":
      return done(cleared(state), withCursor(b, b.cursorRow + count, b.cursorCol))
    case "w": {
      let row = b.cursorRow
      let col = b.cursorCol
      for (let i = 0; i < count; i++) {
        const next = nextWordStartCol(b.lines[row], col)
        if (next >= b.lines[row].length && row < b.lines.length - 1) {
          // Wrap to the next line's first word (vim `w` crosses newlines).
          row += 1
          col = firstNonBlankCol(b.lines[row])
        } else {
          col = next
        }
      }
      return done(cleared(state), withCursor(b, row, col))
    }
    case "b": {
      let probe: InputBuffer = b
      for (let i = 0; i < count; i++) probe = moveWordLeft(probe)
      return done(cleared(state), withCursor(probe, probe.cursorRow, probe.cursorCol))
    }
    case "e":
      return done(cleared(state), withCursor(b, b.cursorRow, wordEndCol(line, b.cursorCol)))
    case "0":
      return done(cleared(state), withCursor(b, b.cursorRow, 0))
    case "^":
      return done(cleared(state), withCursor(b, b.cursorRow, firstNonBlankCol(line)))
    case "$":
      return done(cleared(state), withCursor(b, b.cursorRow, line.length - 1))
    case "G": {
      const row = state.count === "" ? b.lines.length - 1 : count - 1
      const target = Math.max(0, Math.min(row, b.lines.length - 1))
      return done(cleared(state), withCursor(b, target, firstNonBlankCol(b.lines[target])))
    }
    case "g":
      return done({ ...state, pending: "g" }, b)

    // ── search ──
    case "/":
      return done({ ...cleared(state), search: { dir: "fwd", query: "" } }, b)
    case "?":
      return done({ ...cleared(state), search: { dir: "back", query: "" } }, b)
    case "n":
    case "N": {
      const last = state.lastSearch
      if (!last) return done(cleared(state), b)
      const dir = ch === "n" ? last.dir : last.dir === "fwd" ? "back" : "fwd"
      const hit = nextVimSearchMatch(b, { ...last, dir })
      return done(cleared(state), hit ? { ...b, cursorRow: hit.row, cursorCol: hit.col } : b)
    }

    // ── repeat ──
    case ".":
      return replayVimChange(cleared(state), b)

    // ── operators ──
    case "d":
    case "c":
    case "y":
      return done({ ...state, pending: ch }, b)

    // ── edits ──
    case "x": {
      const { b: next, cut } = deleteSpan(b, b.cursorCol, b.cursorCol + count)
      return done(
        {
          ...cleared(state),
          register: cut ? { text: cut, linewise: false } : state.register,
          lastChange: { op: "delete-chars", dir: 1, count },
        },
        next
      )
    }
    case "X": {
      const { b: next, cut } = deleteSpan(b, b.cursorCol - count, b.cursorCol)
      return done(
        {
          ...cleared(state),
          register: cut ? { text: cut, linewise: false } : state.register,
          lastChange: { op: "delete-chars", dir: -1, count },
        },
        next
      )
    }
    case "D": {
      const { b: next, cut } = deleteSpan(b, b.cursorCol, line.length)
      return done(
        {
          ...cleared(state),
          register: { text: cut, linewise: false },
          lastChange: { op: "delete-to-eol" },
        },
        next
      )
    }
    case "C": {
      const { b: next, cut } = deleteSpan(b, b.cursorCol, line.length)
      const change: VimTextChange = { op: "change-to-eol", text: "" }
      return {
        state: {
          ...toInsert(state, change, next),
          register: { text: cut, linewise: false },
        },
        buffer: { ...next, cursorCol: Math.min(b.cursorCol, next.lines[next.cursorRow].length) },
        handled: true,
      }
    }
    case "s": {
      const { b: next, cut } = deleteSpan(b, b.cursorCol, b.cursorCol + count)
      const change: VimTextChange = { op: "substitute-chars", count, text: "" }
      return {
        state: {
          ...toInsert(state, change, next),
          register: cut ? { text: cut, linewise: false } : state.register,
        },
        buffer: { ...next, cursorCol: Math.min(b.cursorCol, next.lines[next.cursorRow].length) },
        handled: true,
      }
    }
    case "S": {
      const reg = { text: line, linewise: true }
      const lines = [...b.lines]
      lines[b.cursorRow] = ""
      const next = { lines, cursorRow: b.cursorRow, cursorCol: 0 }
      const change: VimTextChange = { op: "substitute-line", text: "" }
      return {
        state: { ...toInsert(state, change, next), register: reg },
        buffer: next,
        handled: true,
      }
    }
    case "p":
    case "P": {
      const reg = state.register
      if (!reg || reg.text === "") return done(cleared(state), b)
      const lastChange: VimChange = { op: "put", after: ch === "p", register: reg }
      if (reg.linewise) {
        const at = ch === "p" ? b.cursorRow + 1 : b.cursorRow
        const lines = [...b.lines.slice(0, at), ...reg.text.split("\n"), ...b.lines.slice(at)]
        return done(cleared({ ...state, lastChange }), {
          lines,
          cursorRow: at,
          cursorCol: firstNonBlankCol(reg.text.split("\n")[0]),
        })
      }
      const at = ch === "p" ? Math.min(line.length, b.cursorCol + 1) : b.cursorCol
      const lines = [...b.lines]
      lines[b.cursorRow] = line.slice(0, at) + reg.text + line.slice(at)
      return done(cleared({ ...state, lastChange }), {
        lines,
        cursorRow: b.cursorRow,
        cursorCol: clampCol(lines[b.cursorRow], at + reg.text.length - 1),
      })
    }
    case "u":
      return done(cleared(state), b, "undo")

    default:
      // Unknown NORMAL key: swallow it (never insert text in NORMAL mode).
      return done(cleared(state), b)
  }
}
