import * as XLSX from "xlsx"

export const WORKBOOK_SCHEMA_VERSION = 1 as const
export const WORKBOOK_ARTIFACT_KIND = "cognia-office/workbook"

export type WorkbookCellType = "string" | "number" | "boolean" | "date" | "blank" | "error"

export interface WorkbookCellStyle {
  numberFormat?: string
  font?: { bold?: boolean; italic?: boolean; color?: string }
  fill?: { color: string }
  alignment?: {
    horizontal?: "left" | "center" | "right"
    vertical?: "top" | "middle" | "bottom"
    wrapText?: boolean
  }
}

export interface WorkbookCell {
  type: WorkbookCellType
  value?: string | number | boolean
  formula?: string
  style?: WorkbookCellStyle
}

export interface WorkbookSheet {
  id: string
  title: string
  cells: Record<string, WorkbookCell>
  merges: string[]
  filter?: string
  freeze?: { rows?: number; columns?: number }
  rowDimensions?: Record<string, { height?: number; hidden?: boolean }>
  columnDimensions?: Record<string, { width?: number; hidden?: boolean }>
}

export interface WorkbookDocument {
  schemaVersion: typeof WORKBOOK_SCHEMA_VERSION
  title: string
  sheets: WorkbookSheet[]
  unsupportedFeatures: string[]
  recalculateOnOpen: true
  sourceFilename?: string
}

export type WorkbookOperation =
  | { op: "setCell"; sheet: string; cell: string; value: WorkbookCell }
  | { op: "setRange"; sheet: string; range: string; values: WorkbookCell[][] }
  | { op: "addSheet"; title: string; index?: number }
  | { op: "deleteSheet"; sheet: string }
  | { op: "renameSheet"; sheet: string; title: string }
  | { op: "reorderSheet"; sheet: string; index: number }
  | { op: "merge"; sheet: string; range: string }
  | { op: "unmerge"; sheet: string; range: string }
  | { op: "setFilter"; sheet: string; range?: string }
  | { op: "setFreeze"; sheet: string; rows?: number; columns?: number }
  | { op: "setRowDimension"; sheet: string; row: number; height?: number; hidden?: boolean }
  | { op: "setColumnDimension"; sheet: string; column: string; width?: number; hidden?: boolean }

export interface WorkbookValidationFinding {
  severity: "error" | "warning"
  code: string
  message: string
  remediation: string
  sheet?: string
  cell?: string
}

export function createWorkbook(title: string, sheetTitle = "Sheet1"): WorkbookDocument {
  const cleanTitle = requireText(title, "title")
  return {
    schemaVersion: WORKBOOK_SCHEMA_VERSION,
    title: cleanTitle,
    sheets: [createSheet(sheetTitle, 1)],
    unsupportedFeatures: [],
    recalculateOnOpen: true,
  }
}

export function parseWorkbook(content: string): WorkbookDocument {
  const parsed = JSON.parse(content) as WorkbookDocument
  if (parsed.schemaVersion !== WORKBOOK_SCHEMA_VERSION) {
    throw new Error(`unsupported workbook schema version: ${String(parsed.schemaVersion)}`)
  }
  const findings = validateWorkbook(parsed)
  const error = findings.find((finding) => finding.severity === "error")
  if (error) throw new Error(`${error.code}: ${error.message}`)
  return parsed
}

export function applyWorkbookOperations(
  workbook: WorkbookDocument,
  operations: readonly WorkbookOperation[]
): WorkbookDocument {
  const next = structuredClone(workbook)
  for (const operation of operations) applyOperation(next, operation)
  const error = validateWorkbook(next).find((finding) => finding.severity === "error")
  if (error) throw new Error(`${error.code}: ${error.message}`)
  return next
}

export function validateWorkbook(workbook: WorkbookDocument): WorkbookValidationFinding[] {
  const findings: WorkbookValidationFinding[] = []
  if (!workbook.title?.trim()) {
    findings.push(
      error("title.empty", "Workbook title is required.", "Set a non-empty workbook title.")
    )
  }
  if (!Array.isArray(workbook.sheets) || workbook.sheets.length === 0) {
    findings.push(
      error(
        "sheets.empty",
        "A workbook must contain at least one sheet.",
        "Add at least one worksheet."
      )
    )
    return findings
  }
  const titles = new Set<string>()
  const ids = new Set<string>()
  for (const sheet of workbook.sheets) {
    if (!sheet.title?.trim()) {
      findings.push(
        error("sheet.title.empty", "Sheet title is required.", "Rename the sheet.", sheet.title)
      )
    } else if (
      sheet.title.length > 31 ||
      [...sheet.title].some((character) => "\\/?*[]:".includes(character))
    ) {
      findings.push(
        error(
          "sheet.title.invalid",
          `Invalid Excel sheet title: ${sheet.title}`,
          "Use at most 31 characters and remove \\, /, ?, *, [, ], and :.",
          sheet.title
        )
      )
    }
    const titleKey = sheet.title.toLocaleLowerCase()
    if (titles.has(titleKey)) {
      findings.push(
        error(
          "sheet.title.duplicate",
          `Duplicate sheet title: ${sheet.title}`,
          "Rename one of the duplicate sheets.",
          sheet.title
        )
      )
    }
    if (ids.has(sheet.id)) {
      findings.push(
        error(
          "sheet.id.duplicate",
          `Duplicate sheet id: ${sheet.id}`,
          "Recreate the duplicated sheet so it receives a unique id.",
          sheet.title
        )
      )
    }
    titles.add(titleKey)
    ids.add(sheet.id)
    for (const [ref, cell] of Object.entries(sheet.cells)) {
      if (!isCellRef(ref)) {
        findings.push(
          error(
            "cell.ref.invalid",
            `Invalid cell reference: ${ref}`,
            "Use an A1-style cell reference such as B4.",
            sheet.title,
            ref
          )
        )
      }
      if (cell.formula !== undefined && !cell.formula.trim()) {
        findings.push(
          error(
            "cell.formula.empty",
            "Formula cannot be empty.",
            "Remove the formula or provide a valid Excel formula.",
            sheet.title,
            ref
          )
        )
      }
      if (cell.type === "number" && cell.value !== undefined && typeof cell.value !== "number") {
        findings.push(
          error(
            "cell.type.invalid",
            "Number cell has a non-number value.",
            "Provide a numeric value or change the cell type.",
            sheet.title,
            ref
          )
        )
      }
    }
    for (const merge of sheet.merges) {
      if (!isRangeRef(merge)) {
        findings.push(
          error(
            "merge.invalid",
            `Invalid merge range: ${merge}`,
            "Use an A1-style range such as A1:C1.",
            sheet.title
          )
        )
      }
    }
    if (sheet.filter && !isRangeRef(sheet.filter)) {
      findings.push(
        error(
          "filter.invalid",
          `Invalid filter range: ${sheet.filter}`,
          "Use an A1-style range that includes the filter header row.",
          sheet.title
        )
      )
    }
  }
  for (const feature of workbook.unsupportedFeatures) {
    findings.push({
      severity: "warning",
      code: "feature.unsupported",
      message: feature,
      remediation: "Export to a new file only after confirming that this feature may be lost.",
    })
  }
  return findings
}

function applyOperation(workbook: WorkbookDocument, operation: WorkbookOperation): void {
  if (operation.op === "addSheet") {
    const index = operation.index ?? workbook.sheets.length
    if (!Number.isInteger(index) || index < 0 || index > workbook.sheets.length)
      throw new Error("sheet index is out of bounds")
    workbook.sheets.splice(index, 0, createSheet(operation.title, nextSheetId(workbook)))
    return
  }
  const sheetIndex = workbook.sheets.findIndex(
    (sheet) => sheet.id === operation.sheet || sheet.title === operation.sheet
  )
  if (sheetIndex < 0) throw new Error(`sheet not found: ${operation.sheet}`)
  const sheet = workbook.sheets[sheetIndex]
  switch (operation.op) {
    case "deleteSheet":
      if (workbook.sheets.length === 1) throw new Error("cannot delete the last sheet")
      workbook.sheets.splice(sheetIndex, 1)
      break
    case "renameSheet":
      sheet.title = requireText(operation.title, "sheet title")
      break
    case "reorderSheet": {
      if (
        !Number.isInteger(operation.index) ||
        operation.index < 0 ||
        operation.index >= workbook.sheets.length
      )
        throw new Error("sheet index is out of bounds")
      workbook.sheets.splice(sheetIndex, 1)
      workbook.sheets.splice(operation.index, 0, sheet)
      break
    }
    case "setCell":
      if (!isCellRef(operation.cell)) throw new Error(`invalid cell reference: ${operation.cell}`)
      sheet.cells[operation.cell.toUpperCase()] = normalizeCell(operation.value)
      break
    case "setRange": {
      const range = XLSX.utils.decode_range(operation.range)
      const expectedRows = range.e.r - range.s.r + 1
      const expectedColumns = range.e.c - range.s.c + 1
      if (
        operation.values.length !== expectedRows ||
        operation.values.some((row) => row.length !== expectedColumns)
      ) {
        throw new Error("setRange values must match the target range dimensions")
      }
      operation.values.forEach((row, rowOffset) =>
        row.forEach((cell, columnOffset) => {
          sheet.cells[
            XLSX.utils.encode_cell({ r: range.s.r + rowOffset, c: range.s.c + columnOffset })
          ] = normalizeCell(cell)
        })
      )
      break
    }
    case "merge":
      if (!isRangeRef(operation.range)) throw new Error(`invalid merge range: ${operation.range}`)
      if (!sheet.merges.includes(operation.range)) sheet.merges.push(operation.range)
      break
    case "unmerge":
      sheet.merges = sheet.merges.filter((range) => range !== operation.range)
      break
    case "setFilter":
      if (operation.range !== undefined && !isRangeRef(operation.range))
        throw new Error(`invalid filter range: ${operation.range}`)
      sheet.filter = operation.range
      break
    case "setFreeze":
      sheet.freeze = { rows: nonNegative(operation.rows), columns: nonNegative(operation.columns) }
      break
    case "setRowDimension":
      if (!Number.isInteger(operation.row) || operation.row < 1)
        throw new Error("row must be a positive integer")
      sheet.rowDimensions ??= {}
      sheet.rowDimensions[String(operation.row)] = {
        height: positive(operation.height),
        hidden: operation.hidden,
      }
      break
    case "setColumnDimension": {
      const column = operation.column.toUpperCase()
      if (!/^[A-Z]{1,3}$/.test(column)) throw new Error(`invalid column: ${operation.column}`)
      sheet.columnDimensions ??= {}
      sheet.columnDimensions[column] = {
        width: positive(operation.width),
        hidden: operation.hidden,
      }
      break
    }
  }
}

function createSheet(title: string, id: number): WorkbookSheet {
  return { id: `sheet-${id}`, title: requireText(title, "sheet title"), cells: {}, merges: [] }
}

function nextSheetId(workbook: WorkbookDocument): number {
  let id = workbook.sheets.length + 1
  while (workbook.sheets.some((sheet) => sheet.id === `sheet-${id}`)) id += 1
  return id
}

function normalizeCell(cell: WorkbookCell): WorkbookCell {
  const next = structuredClone(cell)
  if (next.formula?.startsWith("=")) next.formula = next.formula.slice(1)
  return next
}

function requireText(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${label} must be a non-empty string`)
  return value.trim()
}

function isCellRef(value: string): boolean {
  try {
    const decoded = XLSX.utils.decode_cell(value)
    return XLSX.utils.encode_cell(decoded) === value.toUpperCase()
  } catch {
    return false
  }
}

function isRangeRef(value: string): boolean {
  try {
    const range = XLSX.utils.decode_range(value)
    return range.s.r <= range.e.r && range.s.c <= range.e.c
  } catch {
    return false
  }
}

function positive(value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isFinite(value) || value <= 0) throw new Error("dimension must be positive")
  return value
}

function nonNegative(value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || value < 0)
    throw new Error("freeze count must be a non-negative integer")
  return value
}

function error(
  code: string,
  message: string,
  remediation: string,
  sheet?: string,
  cell?: string
): WorkbookValidationFinding {
  return {
    severity: "error",
    code,
    message,
    remediation,
    ...(sheet ? { sheet } : {}),
    ...(cell ? { cell } : {}),
  }
}
