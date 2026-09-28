import {
  decodeCell,
  decodeColumn,
  decodeRange,
  encodeCell,
  encodeColumn,
  encodeRange,
  type RangeAddress,
} from "./a1"
import { rewriteWorkbookFormulas } from "./formula-refs"

export const WORKBOOK_SCHEMA_VERSION = 1 as const
export const WORKBOOK_ARTIFACT_KIND = "cognia-office/workbook"

/** Excel worksheet limits (1-based): 1,048,576 rows and 16,384 columns (XFD). */
export const WORKBOOK_MAX_ROW = 1_048_576
export const WORKBOOK_MAX_COLUMN = 16_384
/**
 * Most cells one `setRangeStyle` may materialize. Styling a whole column
 * (`A1:A1048576`) would otherwise write a million cell entries into the
 * artifact; format the populated block instead.
 */
export const MAX_STYLED_RANGE_CELLS = 100_000

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
  | { op: "insertRows"; sheet: string; row: number; count?: number }
  | { op: "deleteRows"; sheet: string; row: number; count?: number }
  | { op: "insertColumns"; sheet: string; column: string; count?: number }
  | { op: "deleteColumns"; sheet: string; column: string; count?: number }
  | { op: "clearRange"; sheet: string; range: string; target?: WorkbookClearTarget }
  | {
      op: "setRangeStyle"
      sheet: string
      range: string
      style: WorkbookCellStyle
      mode?: "merge" | "replace"
    }
  | { op: "appendRows"; sheet: string; rows: WorkbookCell[][]; column?: string }

/**
 * What `clearRange` removes: whole cells (`all`, the default), only their
 * values and formulas (`contents`, keeping formatting), or only formatting
 * (`formats`, keeping values).
 */
export type WorkbookClearTarget = "all" | "contents" | "formats"

/** The operation names, in schema order — the tool schema and tests key off this. */
export const WORKBOOK_OPERATION_NAMES = [
  "setCell",
  "setRange",
  "addSheet",
  "deleteSheet",
  "renameSheet",
  "reorderSheet",
  "merge",
  "unmerge",
  "setFilter",
  "setFreeze",
  "setRowDimension",
  "setColumnDimension",
  "insertRows",
  "deleteRows",
  "insertColumns",
  "deleteColumns",
  "clearRange",
  "setRangeStyle",
  "appendRows",
] as const satisfies ReadonlyArray<WorkbookOperation["op"]>

/**
 * The OOXML features an imported workbook can carry that this model cannot
 * round-trip. `unsupportedFeatures` stores the English sentence (tools hand it
 * to the model verbatim, and older artifacts already hold it); the preview
 * maps it back to its id to show the `feature.<id>` translation.
 */
export const UNSUPPORTED_FEATURES = {
  macros: "Macros are present and will not be preserved when this workbook is exported.",
  pivotTables: "Pivot tables are present and cannot be edited or preserved losslessly.",
  charts: "Complex charts are present and cannot be edited or preserved losslessly.",
  externalLinks: "External workbook links are present and will not be preserved.",
  drawings: "Embedded images or drawing shapes are present and will not be preserved.",
  comments: "Cell comments are present and will not be preserved.",
  tables: "Structured tables are present and will be flattened to plain cell ranges.",
  slicers: "Slicers or timelines are present and will not be preserved.",
  connections: "External data connections are present and will not be preserved.",
  controls: "Form or ActiveX controls are present and will not be preserved.",
  conditionalFormatting: "Conditional formatting is present and will not be preserved.",
  dataValidation: "Cell data validation rules are present and will not be preserved.",
  hyperlinks: "Cell hyperlinks are present and will not be preserved.",
  sheetProtection: "Sheet protection is present and will not be preserved.",
  legacyDrawings: "Legacy comment drawings are present and will not be preserved.",
  uninspectable: "The workbook package could not be inspected for unsupported OOXML features.",
} as const
export type UnsupportedFeatureId = keyof typeof UNSUPPORTED_FEATURES

/** The id of a stored unsupported-feature sentence, or undefined for free text. */
export function unsupportedFeatureId(message: string): UnsupportedFeatureId | undefined {
  return (Object.keys(UNSUPPORTED_FEATURES) as UnsupportedFeatureId[]).find(
    (id) => UNSUPPORTED_FEATURES[id] === message
  )
}

export interface WorkbookValidationFinding {
  severity: "error" | "warning"
  code: string
  /** English text for the model; the preview localizes through `finding.<code>` + `params`. */
  message: string
  remediation: string
  sheet?: string
  cell?: string
  params?: Record<string, string | number>
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

/**
 * Error codes a stored workbook may still carry and be opened with. They block
 * export and any edit that leaves them in place, but refusing to read the
 * artifact would also refuse the edit that repairs it (an `unmerge`).
 */
const READABLE_ERROR_CODES = new Set(["merge.overlap"])

export function parseWorkbook(content: string): WorkbookDocument {
  const parsed = JSON.parse(content) as WorkbookDocument
  if (parsed.schemaVersion !== WORKBOOK_SCHEMA_VERSION) {
    throw new Error(`unsupported workbook schema version: ${String(parsed.schemaVersion)}`)
  }
  const findings = validateWorkbook(parsed)
  const error = findings.find(
    (finding) => finding.severity === "error" && !READABLE_ERROR_CODES.has(finding.code)
  )
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
    const titleKey = sheet.title.toLowerCase()
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
    for (const [first, second] of overlappingMerges(sheet.merges)) {
      findings.push({
        ...error(
          "merge.overlap",
          `Merged ranges ${first} and ${second} overlap.`,
          `Unmerge one of them (unmerge ${second}); Excel cannot open overlapping merges.`,
          sheet.title
        ),
        params: { first, second },
      })
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
      // Formulas elsewhere that read the deleted sheet now read nothing.
      rewriteWorkbookFormulas(workbook.sheets, { kind: "deleteSheet", sheet: sheet.title })
      break
    case "renameSheet": {
      const from = sheet.title
      sheet.title = requireText(operation.title, "sheet title")
      if (from !== sheet.title)
        rewriteWorkbookFormulas(workbook.sheets, { kind: "renameSheet", from, to: sheet.title })
      break
    }
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
    case "setCell": {
      const ref = operation.cell.toUpperCase()
      if (!isCellRef(ref)) throw new Error(`invalid cell reference: ${operation.cell}`)
      sheet.cells[ref] = normalizeCell(operation.value)
      break
    }
    case "setRange": {
      const rangeRef = operation.range.toUpperCase()
      if (!isRangeRef(rangeRef)) throw new Error(`invalid range: ${operation.range}`)
      const range = decodeRange(rangeRef)
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
          sheet.cells[encodeCell({ r: range.s.r + rowOffset, c: range.s.c + columnOffset })] =
            normalizeCell(cell)
        })
      )
      break
    }
    case "merge": {
      const range = operation.range.toUpperCase()
      if (!isRangeRef(range)) throw new Error(`invalid merge range: ${operation.range}`)
      const area = decodeRange(range)
      if (area.s.r === area.e.r && area.s.c === area.e.c)
        throw new Error(`merge range must span at least two cells: ${operation.range}`)
      if (sheet.merges.includes(range)) break
      const clash = sheet.merges.find(
        (existing) => isRangeRef(existing) && rangesIntersect(decodeRange(existing), area)
      )
      if (clash)
        throw new Error(`merge range ${range} overlaps the merged range ${clash}; unmerge it first`)
      sheet.merges.push(range)
      break
    }
    case "unmerge": {
      // Like Excel's "Unmerge Cells" on a selection: every merged area the
      // range touches is released, not only an exact match.
      const range = operation.range.toUpperCase()
      if (!isRangeRef(range)) throw new Error(`invalid unmerge range: ${operation.range}`)
      const area = decodeRange(range)
      sheet.merges = sheet.merges.filter(
        (existing) => !isRangeRef(existing) || !rangesIntersect(decodeRange(existing), area)
      )
      break
    }
    case "setFilter": {
      const range = operation.range?.toUpperCase()
      if (range !== undefined && !isRangeRef(range))
        throw new Error(`invalid filter range: ${operation.range}`)
      sheet.filter = range
      break
    }
    case "setFreeze": {
      const rows = nonNegative(operation.rows, WORKBOOK_MAX_ROW) ?? 0
      const columns = nonNegative(operation.columns, WORKBOOK_MAX_COLUMN) ?? 0
      // No frozen rows or columns means no frozen pane at all.
      if (rows === 0 && columns === 0) delete sheet.freeze
      else sheet.freeze = { ...(rows ? { rows } : {}), ...(columns ? { columns } : {}) }
      break
    }
    case "setRowDimension":
      rowIndex(operation.row)
      sheet.rowDimensions ??= {}
      sheet.rowDimensions[String(operation.row)] = {
        height: positive(operation.height),
        hidden: operation.hidden,
      }
      break
    case "setColumnDimension": {
      const column = operation.column.toUpperCase()
      columnIndex(column)
      sheet.columnDimensions ??= {}
      sheet.columnDimensions[column] = {
        width: positive(operation.width),
        hidden: operation.hidden,
      }
      break
    }
    case "insertRows":
    case "deleteRows":
    case "insertColumns":
    case "deleteColumns": {
      const axis = operation.op.endsWith("Rows") ? "r" : "c"
      const at = "row" in operation ? rowIndex(operation.row) : columnIndex(operation.column)
      const count = operationCount(operation.count)
      const mode = operation.op.startsWith("insert") ? "insert" : "delete"
      shiftSheetAxis(sheet, axis, at, count, mode)
      // Formulas on every sheet that read this one follow the moved cells.
      rewriteWorkbookFormulas(workbook.sheets, {
        kind: "axis",
        sheet: sheet.title,
        axis,
        at,
        count,
        mode,
      })
      break
    }
    case "clearRange":
      clearRange(sheet, requireRange(operation.range), operation.target ?? "all")
      break
    case "setRangeStyle":
      setRangeStyle(sheet, requireRange(operation.range), operation.style, operation.mode)
      break
    case "appendRows":
      appendRows(sheet, operation.rows, operation.column)
      break
  }
}

function requireRange(value: string): RangeAddress {
  const ref = value.toUpperCase()
  if (!isRangeRef(ref)) throw new Error(`invalid range: ${value}`)
  return decodeRange(ref)
}

function inRange(ref: string, range: RangeAddress): boolean {
  const cell = decodeCell(ref)
  return cell.r >= range.s.r && cell.r <= range.e.r && cell.c >= range.s.c && cell.c <= range.e.c
}

function clearRange(sheet: WorkbookSheet, range: RangeAddress, target: WorkbookClearTarget): void {
  if (target !== "all" && target !== "contents" && target !== "formats")
    throw new Error(`invalid clear target: ${String(target)}`)
  for (const [ref, cell] of Object.entries(sheet.cells)) {
    if (!isCellRef(ref) || !inRange(ref, range)) continue
    if (target === "all") {
      delete sheet.cells[ref]
    } else if (target === "formats") {
      delete cell.style
    } else if (cell.style) {
      sheet.cells[ref] = { type: "blank", style: cell.style }
    } else {
      delete sheet.cells[ref]
    }
  }
}

function setRangeStyle(
  sheet: WorkbookSheet,
  range: RangeAddress,
  style: WorkbookCellStyle,
  mode: "merge" | "replace" = "merge"
): void {
  if (mode !== "merge" && mode !== "replace") throw new Error(`invalid style mode: ${String(mode)}`)
  if (!style || typeof style !== "object") throw new Error("style must be an object")
  const area = (range.e.r - range.s.r + 1) * (range.e.c - range.s.c + 1)
  if (area > MAX_STYLED_RANGE_CELLS)
    throw new Error(
      `setRangeStyle covers ${area} cells; style at most ${MAX_STYLED_RANGE_CELLS} at a time`
    )
  for (let r = range.s.r; r <= range.e.r; r += 1) {
    for (let c = range.s.c; c <= range.e.c; c += 1) {
      const ref = encodeCell({ r, c })
      const cell = sheet.cells[ref] ?? { type: "blank" as const }
      const next = mode === "replace" ? structuredClone(style) : mergeStyle(cell.style, style)
      if (Object.keys(next).length) cell.style = next
      else delete cell.style
      if (cell.type === "blank" && cell.value === undefined && !cell.formula && !cell.style) {
        delete sheet.cells[ref]
      } else {
        sheet.cells[ref] = cell
      }
    }
  }
}

/** Layer `patch` over `base`; nested font/alignment keys merge, the rest replace. */
function mergeStyle(
  base: WorkbookCellStyle | undefined,
  patch: WorkbookCellStyle
): WorkbookCellStyle {
  const next: WorkbookCellStyle = structuredClone(base ?? {})
  if (patch.numberFormat !== undefined) next.numberFormat = patch.numberFormat
  if (patch.font) next.font = { ...next.font, ...patch.font }
  if (patch.fill) next.fill = { ...patch.fill }
  if (patch.alignment) next.alignment = { ...next.alignment, ...patch.alignment }
  return next
}

function appendRows(sheet: WorkbookSheet, rows: WorkbookCell[][], column = "A"): void {
  if (!Array.isArray(rows) || rows.length === 0 || rows.some((row) => !Array.isArray(row)))
    throw new Error("appendRows needs at least one row of cells")
  const startColumn = columnIndex(column)
  const used = usedRangeAddress(sheet)
  const firstRow = used ? used.e.r + 1 : 0
  if (firstRow + rows.length > WORKBOOK_MAX_ROW)
    throw new Error("operation pushes content beyond the worksheet bounds")
  rows.forEach((row, rowOffset) =>
    row.forEach((cell, columnOffset) => {
      const c = startColumn + columnOffset
      if (c >= WORKBOOK_MAX_COLUMN)
        throw new Error("operation pushes content beyond the worksheet bounds")
      sheet.cells[encodeCell({ r: firstRow + rowOffset, c })] = normalizeCell(cell)
    })
  )
}

/**
 * The smallest range covering every populated cell and merge, or undefined
 * for an empty sheet. Non-canonical keys are skipped (validation reports them).
 */
export function usedRangeAddress(sheet: WorkbookSheet): RangeAddress | undefined {
  let bounds: RangeAddress | undefined
  const include = (area: RangeAddress) => {
    if (!bounds) {
      bounds = { s: { ...area.s }, e: { ...area.e } }
      return
    }
    bounds.s.r = Math.min(bounds.s.r, area.s.r)
    bounds.s.c = Math.min(bounds.s.c, area.s.c)
    bounds.e.r = Math.max(bounds.e.r, area.e.r)
    bounds.e.c = Math.max(bounds.e.c, area.e.c)
  }
  for (const ref of Object.keys(sheet.cells)) {
    if (!isCellRef(ref)) continue
    const cell = decodeCell(ref)
    include({ s: cell, e: cell })
  }
  for (const merge of sheet.merges) if (isRangeRef(merge)) include(decodeRange(merge))
  return bounds
}

/** `usedRangeAddress` in A1 notation. */
export function usedRange(sheet: WorkbookSheet): string | undefined {
  const bounds = usedRangeAddress(sheet)
  return bounds ? encodeRange(bounds) : undefined
}

/** Compact, model-facing description of a workbook — never its cell payload. */
export interface WorkbookSummary {
  title: string
  sheets: Array<{
    id: string
    title: string
    usedRange?: string
    cellCount: number
    formulaCount: number
    merges: number
    filter?: string
    freeze?: WorkbookSheet["freeze"]
  }>
  unsupportedFeatures: string[]
  sourceFilename?: string
}

export function summarizeWorkbook(workbook: WorkbookDocument): WorkbookSummary {
  return {
    title: workbook.title,
    sheets: workbook.sheets.map((sheet) => {
      const range = usedRange(sheet)
      const cells = Object.values(sheet.cells)
      return {
        id: sheet.id,
        title: sheet.title,
        ...(range ? { usedRange: range } : {}),
        cellCount: cells.length,
        formulaCount: cells.filter((cell) => cell.formula).length,
        merges: sheet.merges.length,
        ...(sheet.filter ? { filter: sheet.filter } : {}),
        ...(sheet.freeze ? { freeze: sheet.freeze } : {}),
      }
    }),
    unsupportedFeatures: workbook.unsupportedFeatures,
    ...(workbook.sourceFilename ? { sourceFilename: workbook.sourceFilename } : {}),
  }
}

function rangesIntersect(a: RangeAddress, b: RangeAddress): boolean {
  return a.s.r <= b.e.r && b.s.r <= a.e.r && a.s.c <= b.e.c && b.s.c <= a.e.c
}

/** Every pair of intersecting merges, found with a sort-and-sweep over rows. */
function overlappingMerges(merges: readonly string[]): Array<[string, string]> {
  const areas = merges
    .filter(isRangeRef)
    .map((ref) => ({ ref, area: decodeRange(ref) }))
    .sort((a, b) => a.area.s.r - b.area.s.r)
  const pairs: Array<[string, string]> = []
  for (let i = 0; i < areas.length; i += 1) {
    for (let j = i + 1; j < areas.length; j += 1) {
      if (areas[j].area.s.r > areas[i].area.e.r) break
      if (rangesIntersect(areas[i].area, areas[j].area)) pairs.push([areas[i].ref, areas[j].ref])
    }
  }
  return pairs
}

/**
 * Insert `count` empty rows/columns at index `at` (0-based) or delete the
 * `[at, at+count)` span, remapping cell keys, merges, filter, freeze and
 * dimension entries to match Excel's behavior.
 */
function shiftSheetAxis(
  sheet: WorkbookSheet,
  axis: "r" | "c",
  at: number,
  count: number,
  mode: "insert" | "delete"
): void {
  const limit = axis === "r" ? WORKBOOK_MAX_ROW : WORKBOOK_MAX_COLUMN
  const delta = mode === "insert" ? count : -count
  // On delete, coordinates inside [at, at+count) are dropped; on insert,
  // coordinates at/after `at` shift up by `count`.
  const mapCoordinate = (value: number): number | null => {
    if (mode === "delete" && value >= at && value < at + count) return null
    const next = value >= at ? value + delta : value
    if (next >= limit) {
      throw new Error("operation pushes content beyond the worksheet bounds")
    }
    return next
  }

  const cells: Record<string, WorkbookCell> = {}
  for (const [ref, cell] of Object.entries(sheet.cells)) {
    const decoded = decodeCell(ref)
    const next = mapCoordinate(decoded[axis])
    if (next === null) continue
    decoded[axis] = next
    cells[encodeCell(decoded)] = cell
  }
  sheet.cells = cells

  sheet.merges = sheet.merges.flatMap((ref) => {
    const remapped = remapRangeAxis(ref, axis, at, count, mode)
    if (!remapped) return []
    // A merge that shrinks to a single cell is degenerate — drop it.
    const range = decodeRange(remapped)
    return range.s.r === range.e.r && range.s.c === range.e.c ? [] : [remapped]
  })
  if (sheet.filter) {
    const remapped = remapRangeAxis(sheet.filter, axis, at, count, mode)
    if (remapped) {
      sheet.filter = remapped
    } else {
      delete sheet.filter
    }
  }

  if (sheet.freeze) {
    const frozen = axis === "r" ? sheet.freeze.rows : sheet.freeze.columns
    if (frozen !== undefined && frozen > 0) {
      const next =
        mode === "insert"
          ? at < frozen
            ? frozen + count
            : frozen
          : frozen - Math.max(0, Math.min(at + count, frozen) - at)
      if (axis === "r") sheet.freeze.rows = next
      else sheet.freeze.columns = next
    }
  }

  const dimensions = axis === "r" ? sheet.rowDimensions : sheet.columnDimensions
  if (dimensions) {
    const remapped: typeof dimensions = {}
    for (const [key, dimension] of Object.entries(dimensions)) {
      const index = axis === "r" ? Number(key) - 1 : columnKeyIndex(key)
      if (!Number.isInteger(index) || index < 0) continue
      const next = mapCoordinate(index)
      if (next === null) continue
      remapped[axis === "r" ? String(next + 1) : encodeColumn(next)] = dimension
    }
    if (axis === "r") sheet.rowDimensions = remapped
    else sheet.columnDimensions = remapped
  }
}

/**
 * Shift one axis of an A1 range across an insert/delete boundary. Deletion
 * clamps the range ends onto the surviving rows/columns — a start inside the
 * deleted span lands on the first survivor, an end inside it lands on the
 * last. Returns null when the span was fully deleted.
 */
function remapRangeAxis(
  ref: string,
  axis: "r" | "c",
  at: number,
  count: number,
  mode: "insert" | "delete"
): string | null {
  const range = decodeRange(ref)
  const shiftStart = (value: number): number =>
    mode === "insert"
      ? value >= at
        ? value + count
        : value
      : value >= at + count
        ? value - count
        : value >= at
          ? at
          : value
  const shiftEnd = (value: number): number =>
    mode === "insert"
      ? value >= at
        ? value + count
        : value
      : value >= at + count
        ? value - count
        : value >= at
          ? at - 1
          : value
  range.s[axis] = shiftStart(range.s[axis])
  range.e[axis] = shiftEnd(range.e[axis])
  if (range.s[axis] > range.e[axis]) return null
  return encodeRange(range)
}

/** A stored column-dimension key's index, or -1 when the key is malformed. */
function columnKeyIndex(key: string): number {
  try {
    return decodeColumn(key)
  } catch {
    return -1
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
    const decoded = decodeCell(value)
    return (
      decoded.r >= 0 &&
      decoded.c >= 0 &&
      decoded.r < WORKBOOK_MAX_ROW &&
      decoded.c < WORKBOOK_MAX_COLUMN &&
      encodeCell(decoded) === value
    )
  } catch {
    return false
  }
}

function isRangeRef(value: string): boolean {
  try {
    const range = decodeRange(value)
    return (
      range.s.r >= 0 &&
      range.s.c >= 0 &&
      range.s.r <= range.e.r &&
      range.s.c <= range.e.c &&
      range.e.r < WORKBOOK_MAX_ROW &&
      range.e.c < WORKBOOK_MAX_COLUMN
    )
  } catch {
    return false
  }
}

function rowIndex(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > WORKBOOK_MAX_ROW)
    throw new Error(`row must be an integer between 1 and ${WORKBOOK_MAX_ROW}`)
  return value - 1
}

function columnIndex(value: string): number {
  const column = value.toUpperCase()
  if (!/^[A-Z]{1,3}$/.test(column)) throw new Error(`invalid column: ${value}`)
  const index = decodeColumn(column)
  if (index < 0 || index >= WORKBOOK_MAX_COLUMN) throw new Error(`invalid column: ${value}`)
  return index
}

function operationCount(value: number | undefined): number {
  const count = value ?? 1
  if (!Number.isInteger(count) || count < 1) throw new Error("count must be a positive integer")
  return count
}

function positive(value: number | undefined): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isFinite(value) || value <= 0) throw new Error("dimension must be positive")
  return value
}

function nonNegative(value: number | undefined, limit: number): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || value < 0 || value > limit)
    throw new Error(`freeze count must be an integer between 0 and ${limit}`)
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
