/**
 * Workbook formula evaluation.
 *
 * A formula is the source of truth and its value is derived: after every
 * committed edit the runtime recalculates the workbook and writes each formula
 * cell's computed value back, so the preview, `office_read_range`, and the
 * exported file's cached results all show what the formula produces — not a
 * number the agent asserted next to it. Import keeps the file's own cached
 * values, and export still stamps `recalculateOnOpen` as belt-and-braces.
 *
 * Evaluation order is static: every formula's references are collected into a
 * dependency graph and evaluated in strongly-connected-component order
 * (iterative Tarjan, so a 50k-cell running total cannot overflow the stack).
 * Cells in a cycle become `#REF!`, as in Google Sheets; cells that read them
 * see that error.
 *
 * Operators, references, `IF`/`IFERROR`/`IFNA` (lazy) and `ROW`/`COLUMN`/
 * `ROWS`/`COLUMNS` (they need the reference, not its values) are native. Every
 * other function comes from `@formulajs/formulajs` (MIT), loaded on first
 * recalculation. What neither can evaluate — defined names, 3D, structured and
 * external references, unknown functions, results that would spill — keeps
 * the cell's cached value when it has one and becomes an error only when it
 * has none (`#NAME?` for names, `#VALUE!` otherwise), and is listed in the
 * report so the agent knows the number is not engine-verified.
 *
 * Recalculation is all-or-nothing under hard budgets (formula count,
 * dependency edges, cell reads, wall time): a workbook too large to
 * recalculate keeps every stored value and says so, rather than half-updating.
 */

import { encodeCell, decodeCell, type RangeAddress } from "./a1"
import {
  FORMULA_ERROR_CODES,
  FormulaSyntaxError,
  FormulaUnsupportedError,
  parseFormula,
  type BinaryOperator,
  type FormulaErrorCode,
  type FormulaNode,
} from "./formula-parser"
import type { RefBody } from "./formula-refs"
import {
  usedRangeAddress,
  WORKBOOK_MAX_COLUMN,
  WORKBOOK_MAX_ROW,
  type WorkbookCell,
  type WorkbookDocument,
} from "./model"
import { dateToSerial, serialToDate } from "./serial-date"

/** Most formula cells one recalculation evaluates. */
export const MAX_RECALC_FORMULA_CELLS = 50_000
/** Most dependency edges the graph may hold (a filled-down `SUM($A$1:A1)` grows quadratically). */
export const MAX_RECALC_DEPENDENCIES = 2_000_000
/** Most cell values one recalculation may read. */
export const MAX_RECALC_CELL_READS = 2_000_000
/** Wall-clock ceiling; the tool call and the preview edit both wait on it. */
export const RECALC_TIME_BUDGET_MS = 3_000
/**
 * A range larger than this is clipped to the sheet's used range before its
 * values are read, so `A:A` reads the populated rows, not a million blanks.
 * Smaller ranges are read exactly (blanks included, for `COUNTBLANK`).
 */
const MAX_UNCLIPPED_RANGE_CELLS = 100_000
/** Report lists are capped; the counts stay exact. */
const MAX_REPORTED_CELLS = 20

/** The formulajs module namespace (functions, plus namespaces such as `STDEV.S`). */
export type FormulaFunctions = Record<string, unknown>

let functionsLoad: Promise<FormulaFunctions> | null = null

/** Load the function library once; a failed chunk load is retried on the next call. */
export function loadFormulaFunctions(): Promise<FormulaFunctions> {
  functionsLoad ??= import("@formulajs/formulajs").then(
    (mod) => mod as unknown as FormulaFunctions,
    (error: unknown) => {
      functionsLoad = null
      throw error
    }
  )
  return functionsLoad
}

export type RecalculationSkipReason =
  "formula-limit" | "dependency-limit" | "read-limit" | "time-limit"

export interface RecalculationIssue {
  sheet: string
  cell: string
  kind: "circular" | "unsupported" | "syntax"
  detail: string
}

/** Model-facing summary of one recalculation. */
export interface RecalculationReport {
  status: "complete" | "skipped"
  /** Why nothing was written, when `status` is "skipped". */
  reason?: RecalculationSkipReason
  formulaCells: number
  /** Formula cells whose value the engine computed. */
  evaluated: number
  errorCount: number
  /** The first formula cells whose computed value is an error. */
  errorCells: Array<{ sheet: string; cell: string; error: FormulaErrorCode }>
  issueCount: number
  /** The first cells the engine could not evaluate (cached values kept where present). */
  issues: RecalculationIssue[]
}

export interface RecalculateOptions {
  /** Clock for the time budget; tests inject one. */
  now?: () => number
  timeBudgetMs?: number
  maxFormulaCells?: number
  maxDependencies?: number
  maxCellReads?: number
}

/**
 * Recalculate every formula in `workbook`, writing computed values into its
 * cells IN PLACE (callers pass the fresh copy `applyWorkbookOperations`
 * returned). When the report says "skipped", the workbook is untouched.
 */
export function recalculateWorkbook(
  workbook: WorkbookDocument,
  functions: FormulaFunctions,
  options: RecalculateOptions = {}
): RecalculationReport {
  const now = options.now ?? Date.now
  const deadline = now() + (options.timeBudgetMs ?? RECALC_TIME_BUDGET_MS)
  const formulas = collectFormulas(workbook)
  const report: RecalculationReport = {
    status: "complete",
    formulaCells: formulas.length,
    evaluated: 0,
    errorCount: 0,
    errorCells: [],
    issueCount: 0,
    issues: [],
  }
  const skip = (reason: RecalculationSkipReason): RecalculationReport => ({
    ...report,
    status: "skipped",
    reason,
    evaluated: 0,
    errorCount: 0,
    errorCells: [],
    issueCount: 0,
    issues: [],
  })
  if (formulas.length === 0) return report
  if (formulas.length > (options.maxFormulaCells ?? MAX_RECALC_FORMULA_CELLS))
    return skip("formula-limit")

  const sheetsByName = new Map(
    workbook.sheets.map((sheet, index) => [sheet.title.toLowerCase(), index])
  )
  const index = indexFormulas(workbook.sheets.length, formulas)
  const edges: number[][] = []
  let edgeCount = 0
  for (const formula of formulas) {
    const targets: number[] = []
    if (formula.ast) {
      collectReferences(formula.ast, (sheetName, body) => {
        const sheet =
          sheetName === undefined ? formula.sheet : sheetsByName.get(sheetName.toLowerCase())
        if (sheet === undefined) return
        index.query(sheet, refArea(body), targets)
      })
    }
    edgeCount += targets.length
    if (edgeCount > (options.maxDependencies ?? MAX_RECALC_DEPENDENCIES))
      return skip("dependency-limit")
    edges.push(targets)
  }

  const results = new Map<number, FormulaResult>()
  const budget = { reads: options.maxCellReads ?? MAX_RECALC_CELL_READS }
  const usedRanges = new Map<number, RangeAddress | undefined>()
  const machine: Machine = {
    workbook,
    functions,
    sheetsByName,
    formulaAt: index.at,
    results,
    budget,
    usedRange: (sheet) => {
      if (!usedRanges.has(sheet)) usedRanges.set(sheet, usedRangeAddress(workbook.sheets[sheet]))
      return usedRanges.get(sheet)
    },
  }
  const addIssue = (
    formula: CollectedFormula,
    kind: RecalculationIssue["kind"],
    detail: string
  ) => {
    report.issueCount += 1
    if (report.issues.length < MAX_REPORTED_CELLS)
      report.issues.push({ sheet: sheetTitle(workbook, formula), cell: formula.ref, kind, detail })
  }

  try {
    for (const component of stronglyConnected(formulas.length, edges)) {
      if (now() > deadline) return skip("time-limit")
      const cyclic = component.length > 1 || edges[component[0]].includes(component[0])
      for (const id of component) {
        const formula = formulas[id]
        if (cyclic) {
          results.set(id, { value: new CellError("#REF!"), date: false })
          addIssue(formula, "circular", "the formula refers to itself through its references")
          continue
        }
        results.set(id, evaluateFormula(machine, formula, addIssue, report))
      }
    }
  } catch (error) {
    if (error instanceof ReadBudgetExceeded) return skip("read-limit")
    throw error
  }

  for (const [id, result] of results) {
    const formula = formulas[id]
    const next = writeResult(formula.cell, result)
    workbook.sheets[formula.sheet].cells[formula.ref] = next
    if (next.type === "error") {
      report.errorCount += 1
      if (report.errorCells.length < MAX_REPORTED_CELLS)
        report.errorCells.push({
          sheet: sheetTitle(workbook, formula),
          cell: formula.ref,
          error: next.value as FormulaErrorCode,
        })
    }
  }
  return report
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

class CellError {
  constructor(readonly code: FormulaErrorCode) {}
}

type Scalar = number | string | boolean | null | CellError
type Matrix = Scalar[][]
type Value = Scalar | Matrix

interface FormulaResult {
  value: Scalar
  /** The root call returned a Date (`DATE`, `TODAY`, …): store the cell as a date. */
  date: boolean
  /** Engine could not evaluate: keep the stored value, or fall back to `fallback`. */
  unevaluated?: { fallback: FormulaErrorCode }
}

const ERROR_CODES = new Set<string>(FORMULA_ERROR_CODES)

/** Functions whose reference arguments are addresses, never read. */
const REFERENCE_ONLY_FUNCTIONS = new Set(["ROW", "COLUMN", "ROWS", "COLUMNS"])
/** Functions that need the evaluator itself; formulajs versions are never used. */
const NATIVE_FUNCTIONS = new Set(["IF", "IFERROR", "IFNA", ...REFERENCE_ONLY_FUNCTIONS])

class ReadBudgetExceeded extends Error {}

const isMatrix = (value: Value): value is Matrix => Array.isArray(value)

function toNumber(value: Scalar): number | CellError {
  if (value instanceof CellError) return value
  if (typeof value === "number") return value
  if (value === null) return 0
  if (typeof value === "boolean") return value ? 1 : 0
  const text = value.trim()
  const parsed = text === "" ? Number.NaN : Number(text)
  return Number.isFinite(parsed) ? parsed : new CellError("#VALUE!")
}

function toText(value: Scalar): string | CellError {
  if (value instanceof CellError) return value
  if (value === null) return ""
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE"
  if (typeof value === "number") return String(roundToExcelPrecision(value))
  return value
}

function toBoolean(value: Scalar): boolean | CellError {
  if (value instanceof CellError) return value
  if (typeof value === "boolean") return value
  if (value === null) return false
  if (typeof value === "number") return value !== 0
  const upper = value.trim().toUpperCase()
  if (upper === "TRUE") return true
  if (upper === "FALSE") return false
  return new CellError("#VALUE!")
}

/** Excel keeps 15 significant digits, which is what makes 0.1+0.2 equal 0.3. */
function roundToExcelPrecision(value: number): number {
  return value === 0 ? 0 : Number(value.toPrecision(15))
}

/** A numeric result, or `#NUM!` for NaN / ±Infinity (Excel has neither). */
function finite(value: number): number | CellError {
  return Number.isFinite(value) ? value : new CellError("#NUM!")
}

/** Excel orders number < text < logical; text compares case-insensitively. */
function compareScalars(left: Scalar, right: Scalar, op: BinaryOperator): Scalar {
  if (left instanceof CellError) return left
  if (right instanceof CellError) return right
  const blankAs = (other: Scalar) =>
    typeof other === "string" ? "" : typeof other === "boolean" ? false : 0
  const a = left === null ? blankAs(right) : left
  const b = right === null ? blankAs(left) : right
  const rank = (value: number | string | boolean) =>
    typeof value === "number" ? 0 : typeof value === "string" ? 1 : 2
  let order: number
  if (rank(a) !== rank(b)) order = rank(a) - rank(b)
  else if (typeof a === "string") {
    const x = a.toLowerCase()
    const y = (b as string).toLowerCase()
    order = x < y ? -1 : x > y ? 1 : 0
  } else order = Number(a) - Number(b)
  switch (op) {
    case "=":
      return order === 0
    case "<>":
      return order !== 0
    case "<":
      return order < 0
    case ">":
      return order > 0
    case "<=":
      return order <= 0
    default:
      return order >= 0
  }
}

function applyBinary(op: BinaryOperator, left: Scalar, right: Scalar): Scalar {
  if (op === "&") {
    const a = toText(left)
    if (a instanceof CellError) return a
    const b = toText(right)
    return b instanceof CellError ? b : a + b
  }
  if (op === "+" || op === "-" || op === "*" || op === "/" || op === "^") {
    const a = toNumber(left)
    if (a instanceof CellError) return a
    const b = toNumber(right)
    if (b instanceof CellError) return b
    switch (op) {
      case "+":
        return finite(a + b)
      case "-":
        return finite(a - b)
      case "*":
        return finite(a * b)
      case "/":
        return b === 0 ? new CellError("#DIV/0!") : finite(a / b)
      default:
        return a === 0 && b === 0 ? new CellError("#NUM!") : finite(a ** b)
    }
  }
  return compareScalars(left, right, op)
}

/** Apply `fn` element-wise, broadcasting a scalar or a single row/column like Excel. */
function lift(values: Value[], fn: (...scalars: Scalar[]) => Scalar): Value {
  if (!values.some(isMatrix)) return fn(...(values as Scalar[]))
  const rows = Math.max(...values.map((value) => (isMatrix(value) ? value.length : 1)))
  const columns = Math.max(
    ...values.map((value) => (isMatrix(value) ? (value[0]?.length ?? 0) : 1))
  )
  const at = (value: Value, r: number, c: number): Scalar => {
    if (!isMatrix(value)) return value
    const row = value.length === 1 ? value[0] : value[r]
    if (!row) return new CellError("#N/A")
    const cell = row.length === 1 ? row[0] : row[c]
    return cell === undefined ? new CellError("#N/A") : cell
  }
  return Array.from({ length: rows }, (_, r) =>
    Array.from({ length: columns }, (_, c) => fn(...values.map((value) => at(value, r, c))))
  )
}

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

interface CollectedFormula {
  sheet: number
  ref: string
  row: number
  column: number
  cell: WorkbookCell
  ast?: FormulaNode
  failure?: FormulaSyntaxError | FormulaUnsupportedError
}

function collectFormulas(workbook: WorkbookDocument): CollectedFormula[] {
  const out: CollectedFormula[] = []
  const parsed = new Map<string, FormulaNode | FormulaSyntaxError | FormulaUnsupportedError>()
  workbook.sheets.forEach((sheet, sheetIndex) => {
    for (const [ref, cell] of Object.entries(sheet.cells)) {
      if (!cell.formula) continue
      let address
      try {
        address = decodeCell(ref)
      } catch {
        continue
      }
      // Identical formula text parses identically wherever it sits: unprefixed
      // references resolve against the host sheet at evaluation, not here.
      let tree = parsed.get(cell.formula)
      if (!tree) {
        try {
          tree = parseFormula(cell.formula)
        } catch (error) {
          if (!(error instanceof FormulaSyntaxError || error instanceof FormulaUnsupportedError))
            throw error
          tree = error
        }
        parsed.set(cell.formula, tree)
      }
      out.push({
        sheet: sheetIndex,
        ref,
        row: address.r,
        column: address.c,
        cell,
        ...(tree instanceof Error ? { failure: tree } : { ast: tree }),
      })
    }
  })
  return out
}

function collectReferences(
  node: FormulaNode,
  visit: (sheet: string | undefined, body: RefBody) => void
): void {
  switch (node.kind) {
    case "ref":
      visit(node.sheet, node.body)
      return
    case "unary":
    case "percent":
      collectReferences(node.operand, visit)
      return
    case "binary":
      collectReferences(node.left, visit)
      collectReferences(node.right, visit)
      return
    case "call":
      for (const arg of node.args) {
        // ROW(A:A) / ROWS(A:A) read the address, not the values: no dependency,
        // so `=ROWS(A:A)` in A1 is not circular (as in Excel).
        if (!arg || (arg.kind === "ref" && REFERENCE_ONLY_FUNCTIONS.has(node.name))) continue
        collectReferences(arg, visit)
      }
      return
    default:
      return
  }
}

/** The (normalized) area a reference covers, full rows/columns included. */
function refArea(body: RefBody): RangeAddress {
  if (body.type === "area")
    return {
      s: { r: Math.min(body.start.r, body.end.r), c: Math.min(body.start.c, body.end.c) },
      e: { r: Math.max(body.start.r, body.end.r), c: Math.max(body.start.c, body.end.c) },
    }
  if (body.type === "columns")
    return {
      s: { r: 0, c: Math.min(body.start.c, body.end.c) },
      e: { r: WORKBOOK_MAX_ROW - 1, c: Math.max(body.start.c, body.end.c) },
    }
  return {
    s: { r: Math.min(body.start.r, body.end.r), c: 0 },
    e: { r: Math.max(body.start.r, body.end.r), c: WORKBOOK_MAX_COLUMN - 1 },
  }
}

/** Formula cells per sheet, by column then row, for range → dependency lookups. */
function indexFormulas(sheetCount: number, formulas: CollectedFormula[]) {
  const byColumn = Array.from({ length: sheetCount }, () => new Map<number, number[]>())
  const byRef = new Map<string, number>()
  formulas.forEach((formula, id) => {
    const columns = byColumn[formula.sheet]
    const list = columns.get(formula.column) ?? []
    list.push(id)
    columns.set(formula.column, list)
    byRef.set(`${formula.sheet}!${formula.ref}`, id)
  })
  for (const columns of byColumn)
    for (const list of columns.values()) list.sort((a, b) => formulas[a].row - formulas[b].row)
  return {
    at: (sheet: number, ref: string) => byRef.get(`${sheet}!${ref}`),
    query: (sheet: number, area: RangeAddress, into: number[]) => {
      for (const [column, list] of byColumn[sheet]) {
        if (column < area.s.c || column > area.e.c) continue
        let low = 0
        let high = list.length
        while (low < high) {
          const middle = (low + high) >> 1
          if (formulas[list[middle]].row < area.s.r) low = middle + 1
          else high = middle
        }
        for (let i = low; i < list.length && formulas[list[i]].row <= area.e.r; i += 1)
          into.push(list[i])
      }
    },
  }
}

/**
 * Strongly connected components of `edges` (node → the nodes it reads), with
 * every component emitted after the components it depends on. Iterative, so
 * the depth of a dependency chain is bounded by memory, not the call stack.
 */
export function stronglyConnected(count: number, edges: number[][]): number[][] {
  const order = new Int32Array(count).fill(-1)
  const low = new Int32Array(count)
  const onStack = new Uint8Array(count)
  const stack: number[] = []
  const components: number[][] = []
  const work: Array<[node: number, edge: number]> = []
  let counter = 0
  for (let root = 0; root < count; root += 1) {
    if (order[root] !== -1) continue
    work.push([root, 0])
    while (work.length > 0) {
      const frame = work[work.length - 1]
      const node = frame[0]
      if (frame[1] === 0 && order[node] === -1) {
        order[node] = low[node] = counter++
        stack.push(node)
        onStack[node] = 1
      }
      const next = edges[node]
      let descended = false
      while (frame[1] < next.length) {
        const target = next[frame[1]++]
        if (order[target] === -1) {
          work.push([target, 0])
          descended = true
          break
        }
        if (onStack[target]) low[node] = Math.min(low[node], order[target])
      }
      if (descended) continue
      if (low[node] === order[node]) {
        const component: number[] = []
        let member: number
        do {
          member = stack.pop() as number
          onStack[member] = 0
          component.push(member)
        } while (member !== node)
        components.push(component)
      }
      work.pop()
      if (work.length > 0) {
        const parent = work[work.length - 1][0]
        low[parent] = Math.min(low[parent], low[node])
      }
    }
  }
  return components
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

interface Machine {
  workbook: WorkbookDocument
  functions: FormulaFunctions
  sheetsByName: Map<string, number>
  formulaAt: (sheet: number, ref: string) => number | undefined
  results: Map<number, FormulaResult>
  budget: { reads: number }
  usedRange: (sheet: number) => RangeAddress | undefined
}

interface Scope {
  sheet: number
  row: number
  column: number
  root: FormulaNode
  /** Set when the root call returned a Date. */
  date: boolean
}

function evaluateFormula(
  machine: Machine,
  formula: CollectedFormula,
  addIssue: (formula: CollectedFormula, kind: RecalculationIssue["kind"], detail: string) => void,
  report: RecalculationReport
): FormulaResult {
  const unevaluated = (failure: FormulaSyntaxError | FormulaUnsupportedError): FormulaResult => {
    addIssue(
      formula,
      failure instanceof FormulaSyntaxError ? "syntax" : "unsupported",
      failure.message
    )
    const fallback =
      failure instanceof FormulaUnsupportedError && !failure.unknownName ? "#VALUE!" : "#NAME?"
    return { value: storedScalar(formula.cell), date: false, unevaluated: { fallback } }
  }
  if (!formula.ast) return unevaluated(formula.failure as FormulaSyntaxError)
  const scope: Scope = {
    sheet: formula.sheet,
    row: formula.row,
    column: formula.column,
    root: formula.ast,
    date: false,
  }
  try {
    let value = evaluate(machine, formula.ast, scope)
    if (isMatrix(value)) {
      if (value.length !== 1 || value[0].length !== 1)
        throw new FormulaUnsupportedError("the result is an array that would spill")
      value = value[0][0]
    }
    report.evaluated += 1
    return { value, date: scope.date }
  } catch (error) {
    if (error instanceof FormulaUnsupportedError) return unevaluated(error)
    throw error
  }
}

function evaluate(machine: Machine, node: FormulaNode, scope: Scope): Value {
  switch (node.kind) {
    case "number":
    case "string":
    case "boolean":
      return node.value
    case "error":
      return new CellError(node.code)
    case "array":
      return node.rows.map((row) =>
        row.map((item) => (typeof item === "object" ? new CellError(item.error) : item))
      )
    case "ref":
      return readReference(machine, node, scope)
    case "unary": {
      const operand = evaluate(machine, node.operand, scope)
      return lift([operand], (value) => {
        const number = toNumber(value)
        if (number instanceof CellError) return number
        return node.op === "-" ? -number : number
      })
    }
    case "percent":
      return lift([evaluate(machine, node.operand, scope)], (value) => {
        const number = toNumber(value)
        return number instanceof CellError ? number : number / 100
      })
    case "binary":
      return lift(
        [evaluate(machine, node.left, scope), evaluate(machine, node.right, scope)],
        (left, right) => applyBinary(node.op, left, right)
      )
    case "call":
      return evaluateCall(machine, node, scope)
  }
}

function resolveSheet(machine: Machine, node: Extract<FormulaNode, { kind: "ref" }>, scope: Scope) {
  return node.sheet === undefined ? scope.sheet : machine.sheetsByName.get(node.sheet.toLowerCase())
}

function readReference(
  machine: Machine,
  node: Extract<FormulaNode, { kind: "ref" }>,
  scope: Scope
): Value {
  const sheet = resolveSheet(machine, node, scope)
  if (sheet === undefined) return new CellError("#REF!")
  const area = refArea(node.body)
  if (node.body.type === "area" && node.body.single)
    return readCell(machine, sheet, area.s.r, area.s.c)
  const size = (area.e.r - area.s.r + 1) * (area.e.c - area.s.c + 1)
  if (size > MAX_UNCLIPPED_RANGE_CELLS) {
    const used = machine.usedRange(sheet)
    area.e.r = Math.max(area.s.r, Math.min(area.e.r, used?.e.r ?? area.s.r))
    area.e.c = Math.max(area.s.c, Math.min(area.e.c, used?.e.c ?? area.s.c))
  }
  const rows: Matrix = []
  for (let r = area.s.r; r <= area.e.r; r += 1) {
    const row: Scalar[] = []
    for (let c = area.s.c; c <= area.e.c; c += 1) row.push(readCell(machine, sheet, r, c))
    rows.push(row)
  }
  return rows
}

function readCell(machine: Machine, sheet: number, row: number, column: number): Scalar {
  if (--machine.budget.reads < 0) throw new ReadBudgetExceeded()
  const ref = encodeCell({ r: row, c: column })
  const id = machine.formulaAt(sheet, ref)
  const computed = id === undefined ? undefined : machine.results.get(id)
  if (computed) {
    if (!computed.unevaluated) return computed.value
    return computed.value === null ? new CellError(computed.unevaluated.fallback) : computed.value
  }
  return storedScalar(machine.workbook.sheets[sheet].cells[ref])
}

/** A stored cell as an evaluator value (dates become serials). */
function storedScalar(cell: WorkbookCell | undefined): Scalar {
  if (!cell || cell.value === undefined || cell.type === "blank") return null
  if (cell.type === "error") {
    const code = String(cell.value).toUpperCase()
    return new CellError(ERROR_CODES.has(code) ? (code as FormulaErrorCode) : "#VALUE!")
  }
  if (cell.type === "date") {
    const date = new Date(String(cell.value))
    return Number.isNaN(date.getTime()) ? String(cell.value) : dateToSerial(date)
  }
  return cell.value
}

function evaluateCall(
  machine: Machine,
  node: Extract<FormulaNode, { kind: "call" }>,
  scope: Scope
): Value {
  if (NATIVE_FUNCTIONS.has(node.name)) return evaluateNative(machine, node, scope)
  const fn = resolveFunction(machine.functions, node.name)
  if (!fn) throw new FormulaUnsupportedError(`function ${node.name} is not evaluated`, node.name)
  const args = node.args.map((arg) => (arg ? toLibrary(evaluate(machine, arg, scope)) : null))
  let raw: unknown
  try {
    raw = fn(...args)
  } catch (error) {
    raw = error
  }
  if (raw instanceof Date && node === scope.root) scope.date = true
  return fromLibrary(raw)
}

function resolveFunction(
  functions: FormulaFunctions,
  name: string
): ((...args: unknown[]) => unknown) | undefined {
  let target: unknown = functions
  for (const part of name.split(".")) {
    if (!target || typeof target !== "object" || !Object.hasOwn(target, part)) return undefined
    target = (target as Record<string, unknown>)[part]
  }
  return typeof target === "function" ? (target as (...args: unknown[]) => unknown) : undefined
}

/** Evaluator value → formulajs argument (errors become `Error`s it recognizes). */
function toLibrary(value: Value): unknown {
  const convert = (scalar: Scalar) =>
    scalar instanceof CellError ? new Error(scalar.code) : scalar
  return isMatrix(value) ? value.map((row) => row.map(convert)) : convert(value)
}

/** formulajs result → evaluator value. */
function fromLibrary(raw: unknown): Value {
  if (raw instanceof Error)
    return new CellError(
      ERROR_CODES.has(raw.message) ? (raw.message as FormulaErrorCode) : "#VALUE!"
    )
  if (raw instanceof Date)
    return Number.isNaN(raw.getTime()) ? new CellError("#VALUE!") : dateToSerial(raw)
  if (typeof raw === "number") return finite(raw)
  if (typeof raw === "string" || typeof raw === "boolean") return raw
  if (raw === null || raw === undefined) return null
  if (Array.isArray(raw)) {
    const rows = raw.length > 0 && Array.isArray(raw[0]) ? (raw as unknown[][]) : [raw as unknown[]]
    return rows.map((row) =>
      row.map((item) => {
        const value = fromLibrary(item)
        return isMatrix(value) ? new CellError("#VALUE!") : value
      })
    )
  }
  return new CellError("#VALUE!")
}

function evaluateNative(
  machine: Machine,
  node: Extract<FormulaNode, { kind: "call" }>,
  scope: Scope
): Value {
  const [first, second, third] = node.args
  const arg = (item: FormulaNode | null | undefined, blank: Scalar): Value =>
    item ? evaluate(machine, item, scope) : blank
  const arity = (min: number, max: number) => {
    if (node.args.length < min || node.args.length > max) throw new ArityError(node.name)
  }
  try {
    switch (node.name) {
      case "IF": {
        arity(2, 3)
        const condition = arg(first, null)
        // Only a scalar condition can skip the untaken branch.
        if (!isMatrix(condition)) {
          const test = toBoolean(condition)
          if (test instanceof CellError) return test
          return test ? arg(second, 0) : node.args.length > 2 ? arg(third, 0) : false
        }
        const whenFalse = node.args.length > 2 ? arg(third, 0) : false
        return lift([condition, arg(second, 0), whenFalse], (test, yes, no) => {
          const flag = toBoolean(test)
          return flag instanceof CellError ? flag : flag ? yes : no
        })
      }
      case "IFERROR":
      case "IFNA": {
        arity(2, 2)
        const value = arg(first, 0)
        const caught = (scalar: Scalar) =>
          scalar instanceof CellError && (node.name === "IFERROR" || scalar.code === "#N/A")
        if (!isMatrix(value)) return caught(value) ? arg(second, 0) : value
        const fallback = arg(second, 0)
        return lift([value, fallback], (scalar, alternative) =>
          caught(scalar) ? alternative : scalar
        )
      }
      case "ROW":
      case "COLUMN": {
        arity(0, 1)
        const axis = node.name === "ROW" ? "r" : "c"
        if (!first) return (axis === "r" ? scope.row : scope.column) + 1
        if (first.kind !== "ref") return new CellError("#VALUE!")
        if (resolveSheet(machine, first, scope) === undefined) return new CellError("#REF!")
        const area = refArea(first.body)
        const span = area.e[axis] - area.s[axis] + 1
        if (span === 1) return area.s[axis] + 1
        if (span > MAX_UNCLIPPED_RANGE_CELLS)
          throw new FormulaUnsupportedError(
            `${node.name} of a whole ${axis === "r" ? "column" : "row"}`
          )
        const numbers = Array.from({ length: span }, (_, offset) => area.s[axis] + offset + 1)
        return axis === "r" ? numbers.map((value) => [value]) : [numbers]
      }
      default: {
        // ROWS / COLUMNS: counted from the reference, never read.
        arity(1, 1)
        const axis = node.name === "ROWS" ? "r" : "c"
        if (first?.kind === "ref") {
          if (resolveSheet(machine, first, scope) === undefined) return new CellError("#REF!")
          const area = refArea(first.body)
          return area.e[axis] - area.s[axis] + 1
        }
        const value = arg(first, null)
        if (value instanceof CellError) return value
        if (!isMatrix(value)) return 1
        return axis === "r" ? value.length : (value[0]?.length ?? 0)
      }
    }
  } catch (error) {
    if (error instanceof ArityError) return new CellError("#VALUE!")
    throw error
  }
}

/** A native function called with the wrong number of arguments: `#VALUE!`. */
class ArityError extends Error {}

// ---------------------------------------------------------------------------
// Write-back
// ---------------------------------------------------------------------------

function writeResult(cell: WorkbookCell, result: FormulaResult): WorkbookCell {
  const base = { formula: cell.formula, ...(cell.style ? { style: cell.style } : {}) }
  if (result.unevaluated) {
    // Keep the cached value (from the source file, or the author) untouched.
    if (cell.value !== undefined) return cell
    return { ...base, type: "error", value: result.unevaluated.fallback }
  }
  const value = result.value
  if (value instanceof CellError) return { ...base, type: "error", value: value.code }
  // A formula over a blank reads as 0 in Excel.
  if (value === null) return { ...base, type: "number", value: 0 }
  if (typeof value === "number") {
    if (result.date || cell.type === "date") {
      const date = serialToDate(value)
      if (!Number.isNaN(date.getTime())) return { ...base, type: "date", value: date.toISOString() }
    }
    return { ...base, type: "number", value: roundToExcelPrecision(value) }
  }
  if (typeof value === "boolean") return { ...base, type: "boolean", value }
  return { ...base, type: "string", value }
}

function sheetTitle(workbook: WorkbookDocument, formula: CollectedFormula): string {
  return workbook.sheets[formula.sheet].title
}
