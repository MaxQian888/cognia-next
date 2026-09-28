/**
 * Formula reference rewriting for structural workbook edits.
 *
 * Excel keeps formulas pointing at the same data when rows/columns move or a
 * sheet is renamed; a model that only moves cell keys leaves every formula
 * aimed at the old coordinates. This module tokenizes an A1-style formula
 * (without the leading `=`) just far enough to find references, and rewrites
 * each one the way Excel does:
 *
 * - insert rows/columns: references at or after the insertion point shift, a
 *   range that spans the insertion point grows;
 * - delete rows/columns: references inside the deleted span become `#REF!`, a
 *   range that loses part of its span shrinks, one that loses all of it
 *   becomes `#REF!`;
 * - rename a sheet: `Old!A1` / `'Old'!A1` become the new (re-quoted) name;
 * - delete a sheet: references into it become `#REF!`.
 *
 * Absolute markers (`$`) are kept: they govern copying, not structural edits,
 * and Excel shifts absolute references too. String literals, function names
 * (`LOG10(`), structured table references (`Table1[Col]`), and references into
 * external workbooks (`[1]Sheet1!A1`) are never touched. 3D references
 * (`Sheet1:Sheet3!A1`) follow a rename of either endpoint and become `#REF!`
 * when an endpoint sheet is deleted; row/column edits do not shift them,
 * because a single-sheet edit does not move the other sheets in the span.
 *
 * A range that already ends on the last row/column (`A2:A1048576`) stays
 * anchored there when rows are inserted, as in Excel; only a reference whose
 * start would leave the sheet becomes `#REF!`.
 */

import { decodeColumn, encodeColumn } from "./a1"

const MAX_ROW = 1_048_576
const MAX_COLUMN = 16_384
export const REF_ERROR = "#REF!"

export type FormulaEdit =
  | {
      kind: "axis"
      /** Title of the sheet whose rows/columns change. */
      sheet: string
      axis: "r" | "c"
      /** 0-based first row/column of the edit. */
      at: number
      count: number
      mode: "insert" | "delete"
    }
  | { kind: "renameSheet"; from: string; to: string }
  | { kind: "deleteSheet"; sheet: string }

/** One A1 reference, decoded. Row/column indexes are 0-based. */
type RefBody =
  | {
      type: "area"
      start: { c: number; r: number; absC: boolean; absR: boolean }
      end: { c: number; r: number; absC: boolean; absR: boolean }
      single: boolean
    }
  | {
      type: "columns"
      start: { c: number; abs: boolean }
      end: { c: number; abs: boolean }
    }
  | {
      type: "rows"
      start: { r: number; abs: boolean }
      end: { r: number; abs: boolean }
    }

interface SheetPrefix {
  /** Sheet names, one entry (or two for a 3D span), unquoted. */
  names: string[]
  /** Text of the prefix as written, including the trailing `!`. */
  text: string
}

const WORD_CHAR = /[\p{L}\p{N}_.$\\]/u
const SHEET_START = /[\p{L}_\\]/u
/** Sheet names that may appear unquoted; anything else is quoted. */
const BARE_SHEET_NAME = /^[\p{L}_][\p{L}\p{N}_]*$/u
const CELL = /\$?([A-Za-z]{1,3})\$?([0-9]{1,7})/y
const COLUMN = /\$?([A-Za-z]{1,3})/y
const ROW = /\$?([0-9]{1,7})/y

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && WORD_CHAR.test(char)
}

/** Rewrite every reference in `formula` for one structural edit. */
export function rewriteFormula(formula: string, hostSheet: string, edit: FormulaEdit): string {
  let out = ""
  let index = 0
  // Set after a `[...]` group: the next reference belongs to an external
  // workbook or is a structured-reference column, and stays verbatim.
  let external = false
  while (index < formula.length) {
    const char = formula[index]
    if (char === '"') {
      const end = skipString(formula, index)
      out += formula.slice(index, end)
      index = end
      continue
    }
    if (char === "[") {
      const end = skipBrackets(formula, index)
      out += formula.slice(index, end)
      index = end
      external = true
      continue
    }
    if (char === "'") {
      const prefix = readQuotedPrefix(formula, index)
      if (prefix) {
        const ref = readRefBody(formula, prefix.end)
        if (ref) {
          out += external
            ? formula.slice(index, ref.end)
            : rewriteRef(formula.slice(index, ref.end), prefix.prefix, ref.body, hostSheet, edit)
          index = ref.end
          external = false
          continue
        }
      }
      // Not a sheet-qualified reference: copy the quoted run verbatim.
      const end = skipQuoted(formula, index)
      out += formula.slice(index, end)
      index = end
      external = false
      continue
    }
    if (isWordChar(char) && !isWordChar(formula[index - 1])) {
      const prefix = readUnquotedPrefix(formula, index)
      const bodyStart = prefix ? prefix.end : index
      const ref = readRefBody(formula, bodyStart)
      if (ref) {
        out += external
          ? formula.slice(index, ref.end)
          : rewriteRef(formula.slice(index, ref.end), prefix?.prefix, ref.body, hostSheet, edit)
        index = ref.end
        external = false
        continue
      }
      const end = skipWord(formula, index)
      out += formula.slice(index, end)
      index = end
      external = false
      continue
    }
    if (!/\s/.test(char)) external = external && char === "!"
    out += char
    index += 1
  }
  return out
}

/** Rewrite every formula of `sheets` for one structural edit, in place. */
export function rewriteWorkbookFormulas(
  sheets: ReadonlyArray<{ title: string; cells: Record<string, { formula?: string }> }>,
  edit: FormulaEdit
): void {
  for (const sheet of sheets) {
    for (const cell of Object.values(sheet.cells)) {
      if (!cell.formula) continue
      const next = rewriteFormula(cell.formula, sheet.title, edit)
      if (next !== cell.formula) cell.formula = next
    }
  }
}

/** A sheet name as a formula prefix: bare when Excel allows it, quoted otherwise. */
export function formatSheetPrefix(name: string): string {
  const bare = BARE_SHEET_NAME.test(name) && !looksLikeReference(name)
  return bare ? `${name}!` : `'${name.replace(/'/g, "''")}'!`
}

/** A bare sheet name such as `A1`, `R1C1`, or `TRUE` would parse as something else. */
function looksLikeReference(name: string): boolean {
  return (
    /^[A-Za-z]{1,3}[0-9]+$/.test(name) ||
    /^R[0-9]*C[0-9]*$/i.test(name) ||
    /^(TRUE|FALSE)$/i.test(name)
  )
}

// ---------------------------------------------------------------------------
// Rewriting
// ---------------------------------------------------------------------------

/** Excel sheet names compare case-insensitively (as `validateWorkbook` does). */
function sameSheet(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

function rewriteRef(
  original: string,
  prefix: SheetPrefix | undefined,
  body: RefBody,
  hostSheet: string,
  edit: FormulaEdit
): string {
  if (edit.kind === "renameSheet") {
    if (!prefix || !prefix.names.some((name) => sameSheet(name, edit.from))) return original
    const names = prefix.names.map((name) => (sameSheet(name, edit.from) ? edit.to : name))
    return `${formatPrefix(names)}${original.slice(prefix.text.length)}`
  }
  if (edit.kind === "deleteSheet") {
    if (!prefix || !prefix.names.some((name) => sameSheet(name, edit.sheet))) return original
    return REF_ERROR
  }
  if (prefix && prefix.names.length > 1) return original
  const target = prefix ? prefix.names[0] : hostSheet
  if (!sameSheet(target, edit.sheet)) return original
  const shifted = shiftBody(body, edit)
  if (shifted === "unchanged") return original
  if (shifted === null) return REF_ERROR
  return `${prefix?.text ?? ""}${formatBody(shifted)}`
}

function formatPrefix(names: string[]): string {
  if (names.length === 1) return formatSheetPrefix(names[0])
  const parts = names.map((name) => formatSheetPrefix(name).slice(0, -1))
  // A 3D span quotes as one unit when either end needs quoting.
  if (parts.some((part) => part.startsWith("'")))
    return `'${names.map((name) => name.replace(/'/g, "''")).join(":")}'!`
  return `${parts.join(":")}!`
}

type AxisEdit = Extract<FormulaEdit, { kind: "axis" }>

/**
 * Apply an axis edit to one reference: the new body, `null` when the
 * reference no longer points anywhere, or "unchanged".
 */
function shiftBody(body: RefBody, edit: AxisEdit): RefBody | null | "unchanged" {
  const limit = edit.axis === "r" ? MAX_ROW : MAX_COLUMN
  if (body.type === "rows" && edit.axis === "c") return "unchanged"
  if (body.type === "columns" && edit.axis === "r") return "unchanged"
  const [startValue, endValue] =
    body.type === "area"
      ? edit.axis === "r"
        ? [body.start.r, body.end.r]
        : [body.start.c, body.end.c]
      : body.type === "rows"
        ? [body.start.r, body.end.r]
        : [body.start.c, body.end.c]
  const low = Math.min(startValue, endValue)
  const high = Math.max(startValue, endValue)
  const next = shiftSpan(low, high, edit, limit)
  if (next === null) return null
  if (next[0] === low && next[1] === high) return "unchanged"
  // Keep the written orientation (a reversed `B5:B2` stays reversed).
  const [newStart, newEnd] = startValue <= endValue ? next : [next[1], next[0]]
  if (body.type === "area") {
    const key = edit.axis === "r" ? "r" : "c"
    const single = body.single && newStart === newEnd
    return {
      type: "area",
      start: { ...body.start, [key]: newStart },
      end: { ...body.end, [key]: newEnd },
      single,
    }
  }
  if (body.type === "rows")
    return {
      type: "rows",
      start: { ...body.start, r: newStart },
      end: { ...body.end, r: newEnd },
    }
  return {
    type: "columns",
    start: { ...body.start, c: newStart },
    end: { ...body.end, c: newEnd },
  }
}

function shiftSpan(
  low: number,
  high: number,
  edit: AxisEdit,
  limit: number
): [number, number] | null {
  const { at, count } = edit
  if (edit.mode === "insert") {
    const start = low >= at ? low + count : low
    if (start >= limit) return null
    // An end on (or pushed past) the last row/column stays on it.
    const end = high >= at ? Math.min(high + count, limit - 1) : high
    return [start, end]
  }
  const deletedEnd = at + count
  // Fully inside the deleted span.
  if (low >= at && high < deletedEnd) return null
  const start = low >= deletedEnd ? low - count : low >= at ? at : low
  const end = high >= deletedEnd ? high - count : high >= at ? at - 1 : high
  return start > end ? null : [start, end]
}

function formatBody(body: RefBody): string {
  const dollar = (abs: boolean) => (abs ? "$" : "")
  if (body.type === "area") {
    const cell = (point: (typeof body)["start"]) =>
      `${dollar(point.absC)}${encodeColumn(point.c)}${dollar(point.absR)}${point.r + 1}`
    return body.single ? cell(body.start) : `${cell(body.start)}:${cell(body.end)}`
  }
  if (body.type === "columns")
    return `${dollar(body.start.abs)}${encodeColumn(body.start.c)}:${dollar(body.end.abs)}${encodeColumn(body.end.c)}`
  return `${dollar(body.start.abs)}${body.start.r + 1}:${dollar(body.end.abs)}${body.end.r + 1}`
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

function skipString(formula: string, from: number): number {
  let index = from + 1
  while (index < formula.length) {
    if (formula[index] === '"') {
      if (formula[index + 1] === '"') index += 2
      else return index + 1
    } else index += 1
  }
  return formula.length
}

function skipQuoted(formula: string, from: number): number {
  let index = from + 1
  while (index < formula.length) {
    if (formula[index] === "'") {
      if (formula[index + 1] === "'") index += 2
      else return index + 1
    } else index += 1
  }
  return formula.length
}

function skipBrackets(formula: string, from: number): number {
  let depth = 0
  for (let index = from; index < formula.length; index += 1) {
    if (formula[index] === "[") depth += 1
    else if (formula[index] === "]") {
      depth -= 1
      if (depth === 0) return index + 1
    }
  }
  return formula.length
}

function skipWord(formula: string, from: number): number {
  let index = from
  while (index < formula.length && isWordChar(formula[index])) index += 1
  return Math.max(index, from + 1)
}

/** `'Sheet name'!` or `'First:Last'!` starting at a quote. */
function readQuotedPrefix(
  formula: string,
  from: number
): { prefix: SheetPrefix; end: number } | null {
  const close = skipQuoted(formula, from)
  if (formula[close] !== "!" || formula[close - 1] !== "'") return null
  const inner = formula.slice(from + 1, close - 1).replace(/''/g, "'")
  if (!inner) return null
  const names = splitSpan(inner)
  return { prefix: { names, text: formula.slice(from, close + 1) }, end: close + 1 }
}

/** `Sheet1!` or `Sheet1:Sheet3!` starting at a word. */
function readUnquotedPrefix(
  formula: string,
  from: number
): { prefix: SheetPrefix; end: number } | null {
  if (!SHEET_START.test(formula[from])) return null
  let index = skipWord(formula, from)
  const names = [formula.slice(from, index)]
  if (formula[index] === ":" && SHEET_START.test(formula[index + 1] ?? "")) {
    const second = skipWord(formula, index + 1)
    if (formula[second] === "!") {
      names.push(formula.slice(index + 1, second))
      index = second
    }
  }
  if (formula[index] !== "!") return null
  if (names.some((name) => name.includes("$"))) return null
  return { prefix: { names, text: formula.slice(from, index + 1) }, end: index + 1 }
}

/** Split a 3D span (`First:Last`) inside one quoted prefix. */
function splitSpan(inner: string): string[] {
  const colon = inner.indexOf(":")
  return colon > 0 && colon < inner.length - 1
    ? [inner.slice(0, colon), inner.slice(colon + 1)]
    : [inner]
}

/**
 * The character after a candidate must end it: a function call (`LOG10(`),
 * structured reference (`Tbl1[`), or a longer identifier is not a reference.
 */
function terminates(formula: string, index: number): boolean {
  const next = formula[index]
  return !isWordChar(next) && next !== "(" && next !== "[" && next !== "!" && next !== "'"
}

function matchAt(pattern: RegExp, formula: string, index: number): RegExpExecArray | null {
  pattern.lastIndex = index
  return pattern.exec(formula)
}

function readRefBody(formula: string, from: number): { body: RefBody; end: number } | null {
  const first = matchAt(CELL, formula, from)
  if (first) {
    const start = cellPoint(first)
    if (start) {
      const afterFirst = from + first[0].length
      if (formula[afterFirst] === ":") {
        const second = matchAt(CELL, formula, afterFirst + 1)
        const end = second ? cellPoint(second) : null
        if (second && end && terminates(formula, afterFirst + 1 + second[0].length)) {
          return {
            body: { type: "area", start, end, single: false },
            end: afterFirst + 1 + second[0].length,
          }
        }
      }
      if (terminates(formula, afterFirst))
        return { body: { type: "area", start, end: start, single: true }, end: afterFirst }
    }
  }
  const column = matchAt(COLUMN, formula, from)
  if (column && formula[from + column[0].length] === ":") {
    const afterColon = from + column[0].length + 1
    const second = matchAt(COLUMN, formula, afterColon)
    if (second && terminates(formula, afterColon + second[0].length)) {
      const start = columnPoint(column)
      const end = columnPoint(second)
      if (start && end)
        return { body: { type: "columns", start, end }, end: afterColon + second[0].length }
    }
  }
  const row = matchAt(ROW, formula, from)
  if (row && formula[from + row[0].length] === ":") {
    const afterColon = from + row[0].length + 1
    const second = matchAt(ROW, formula, afterColon)
    if (second && terminates(formula, afterColon + second[0].length)) {
      const start = rowPoint(row)
      const end = rowPoint(second)
      if (start && end)
        return { body: { type: "rows", start, end }, end: afterColon + second[0].length }
    }
  }
  return null
}

function cellPoint(match: RegExpExecArray) {
  const column = decodeColumn(match[1].toUpperCase())
  const row = Number.parseInt(match[2], 10)
  if (column >= MAX_COLUMN || row < 1 || row > MAX_ROW) return null
  const text = match[0]
  return {
    c: column,
    r: row - 1,
    absC: text.startsWith("$"),
    absR: text.slice(text.startsWith("$") ? 1 : 0).includes("$"),
  }
}

function columnPoint(match: RegExpExecArray) {
  const column = decodeColumn(match[1].toUpperCase())
  if (column >= MAX_COLUMN) return null
  return { c: column, abs: match[0].startsWith("$") }
}

function rowPoint(match: RegExpExecArray) {
  const row = Number.parseInt(match[1], 10)
  if (row < 1 || row > MAX_ROW) return null
  return { r: row - 1, abs: match[0].startsWith("$") }
}
