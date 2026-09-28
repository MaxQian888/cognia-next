/**
 * Bounded, model-facing reads of workbook content. Tool results go straight
 * into the model's context, so a read returns a row-major grid of plain cell
 * values under a shared cell budget instead of the workbook's JSON payload;
 * formulas travel in a side map so the grid stays compact.
 */

import { decodeRange, encodeCell, encodeRange, type RangeAddress } from "./a1"
import {
  usedRangeAddress,
  WORKBOOK_MAX_COLUMN,
  WORKBOOK_MAX_ROW,
  type WorkbookCell,
  type WorkbookDocument,
  type WorkbookSheet,
} from "./model"

export const DEFAULT_READ_CELLS = 2_000
export const MAX_READ_CELLS = 20_000

export type ReadCellValue = string | number | boolean | null

export interface SheetRead {
  id: string
  title: string
  /** The populated block of the sheet, if any. */
  usedRange?: string
  /** The block actually returned (after clipping to the budget), if any. */
  range?: string
  /** `rows[i][j]` is the cell at `range.start + (i, j)`; `null` is empty. */
  rows: ReadCellValue[][]
  /** Formula text (with a leading `=`) keyed by A1 reference. */
  formulas?: Record<string, string>
  /** True when the requested block did not fit and was clipped. */
  truncated: boolean
}

export interface WorkbookRead {
  sheets: SheetRead[]
  truncated: boolean
  cellsReturned: number
}

export interface ReadWorkbookOptions {
  /** Sheet id or title; every sheet when omitted. */
  sheet?: string
  /** A1 range to read on that sheet; its used range when omitted. */
  range?: string
  maxCells?: number
  includeFormulas?: boolean
}

export function readWorkbook(
  workbook: WorkbookDocument,
  options: ReadWorkbookOptions = {}
): WorkbookRead {
  const budgetLimit = options.maxCells ?? DEFAULT_READ_CELLS
  if (!Number.isInteger(budgetLimit) || budgetLimit < 1 || budgetLimit > MAX_READ_CELLS)
    throw new Error(`maxCells must be an integer between 1 and ${MAX_READ_CELLS}`)
  if (options.range !== undefined && options.sheet === undefined)
    throw new Error("range needs a sheet: pass the sheet id or title it belongs to")
  const sheets =
    options.sheet === undefined
      ? workbook.sheets
      : [
          workbook.sheets.find(
            (candidate) => candidate.id === options.sheet || candidate.title === options.sheet
          ) ?? missingSheet(options.sheet),
        ]
  const requested = options.range === undefined ? undefined : parseRange(options.range)
  let budget = budgetLimit
  let truncated = false
  const reads = sheets.map((sheet) => {
    const read = readSheet(sheet, requested, budget, options.includeFormulas ?? true)
    budget -= read.rows.reduce((total, row) => total + row.length, 0)
    truncated ||= read.truncated
    return read
  })
  return { sheets: reads, truncated, cellsReturned: budgetLimit - budget }
}

function missingSheet(sheet: string): never {
  throw new Error(`sheet not found: ${sheet}`)
}

function parseRange(value: string): RangeAddress {
  let range: RangeAddress
  try {
    range = decodeRange(value.toUpperCase())
  } catch {
    throw new Error(`invalid range: ${value}`)
  }
  if (
    range.s.r > range.e.r ||
    range.s.c > range.e.c ||
    range.e.r >= WORKBOOK_MAX_ROW ||
    range.e.c >= WORKBOOK_MAX_COLUMN
  )
    throw new Error(`invalid range: ${value}`)
  return range
}

function readSheet(
  sheet: WorkbookSheet,
  requested: RangeAddress | undefined,
  budget: number,
  includeFormulas: boolean
): SheetRead {
  const used = usedRangeAddress(sheet)
  const base = {
    id: sheet.id,
    title: sheet.title,
    ...(used ? { usedRange: encodeRange(used) } : {}),
  }
  const target = requested ?? used
  if (!target) return { ...base, rows: [], truncated: false }
  const width = target.e.c - target.s.c + 1
  const height = target.e.r - target.s.r + 1
  if (budget < 1) return { ...base, rows: [], truncated: true }
  // Clip columns first only when a single row would not fit; otherwise keep
  // every column and drop trailing rows, which keeps each record whole.
  const columns = Math.min(width, budget)
  const rowsFit = Math.max(1, Math.floor(budget / columns))
  const rowCount = Math.min(height, rowsFit)
  const clipped: RangeAddress = {
    s: { ...target.s },
    e: { r: target.s.r + rowCount - 1, c: target.s.c + columns - 1 },
  }
  const rows: ReadCellValue[][] = []
  const formulas: Record<string, string> = {}
  for (let r = clipped.s.r; r <= clipped.e.r; r += 1) {
    const row: ReadCellValue[] = []
    for (let c = clipped.s.c; c <= clipped.e.c; c += 1) {
      const ref = encodeCell({ r, c })
      const cell = sheet.cells[ref]
      row.push(cellValue(cell))
      if (includeFormulas && cell?.formula) formulas[ref] = `=${cell.formula}`
    }
    rows.push(row)
  }
  return {
    ...base,
    range: encodeRange(clipped),
    rows,
    ...(Object.keys(formulas).length ? { formulas } : {}),
    truncated: columns < width || rowCount < height,
  }
}

/** A cell as one JSON value: dates stay ISO strings, errors their literal. */
export function cellValue(cell: WorkbookCell | undefined): ReadCellValue {
  if (!cell || cell.type === "blank" || cell.value === undefined) return null
  if (cell.type === "error") return String(cell.value)
  return cell.value
}

/**
 * Plain-text rendering of a read for prompts and reviews: one tab-separated
 * block per sheet, headed by its title and range.
 */
export function formatWorkbookRead(read: WorkbookRead): string {
  return read.sheets
    .map((sheet) => {
      const heading = `## ${sheet.title}${sheet.range ? ` (${sheet.range})` : ""}`
      const body = sheet.rows.length
        ? sheet.rows
            .map((row) => row.map((value) => (value === null ? "" : String(value))).join("\t"))
            .join("\n")
        : "(empty)"
      const formulas = sheet.formulas
        ? `\n\nFormulas:\n${Object.entries(sheet.formulas)
            .map(([ref, formula]) => `${ref}: ${formula}`)
            .join("\n")}`
        : ""
      return `${heading}\n${body}${formulas}${sheet.truncated ? "\n(truncated)" : ""}`
    })
    .join("\n\n")
}
