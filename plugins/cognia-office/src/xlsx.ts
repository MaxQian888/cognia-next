import ExcelJS from "exceljs"
import JSZip from "jszip"
import * as XLSX from "xlsx"
import type { WorkBook, WorkSheet } from "xlsx"
import type { WorkbookCell, WorkbookCellStyle, WorkbookDocument, WorkbookSheet } from "./model"
import { WORKBOOK_SCHEMA_VERSION } from "./model"

export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

export async function importWorkbookXlsx(
  bytes: Uint8Array,
  title: string,
  sourceFilename?: string
): Promise<WorkbookDocument> {
  const binary = XLSX.read(bytes, {
    type: "array",
    cellDates: true,
    cellFormula: true,
    cellStyles: true,
    bookVBA: true,
  })
  const unsupportedFeatures = await detectUnsupportedFeatures(bytes, binary)
  const sheets = binary.SheetNames.map((sheetName, index) =>
    importSheet(binary.Sheets[sheetName], sheetName, index)
  )
  await enrichSheetsFromExcelJs(bytes, sheets)
  return {
    schemaVersion: WORKBOOK_SCHEMA_VERSION,
    title: title.trim() || sourceFilename?.replace(/\.xlsx?$/i, "") || "Workbook",
    sheets,
    unsupportedFeatures,
    recalculateOnOpen: true,
    ...(sourceFilename ? { sourceFilename } : {}),
  }
}

async function enrichSheetsFromExcelJs(bytes: Uint8Array, sheets: WorkbookSheet[]): Promise<void> {
  try {
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(Uint8Array.from(bytes).buffer)
    workbook.worksheets.forEach((worksheet, index) => {
      const sheet = sheets[index]
      if (!sheet) return
      const frozen = worksheet.views.find(
        (view): view is Partial<ExcelJS.WorksheetViewFrozen> => view.state === "frozen"
      )
      if (frozen) {
        sheet.freeze = {
          rows: frozen.ySplit ?? 0,
          columns: frozen.xSplit ?? 0,
        }
      }
      for (const [ref, target] of Object.entries(sheet.cells)) {
        const style = importExcelJsStyle(worksheet.getCell(ref))
        if (style) target.style = style
      }
    })
  } catch {
    // SheetJS still imports delimited/non-OOXML input; native style enrichment
    // is best-effort and intentionally does not turn that compatibility path
    // into a hard failure.
  }
}

function importExcelJsStyle(cell: ExcelJS.Cell): WorkbookCellStyle | undefined {
  const fontColor = cell.font?.color as { argb?: string } | undefined
  const fill = cell.fill as { type?: string; fgColor?: { argb?: string } }
  const horizontal = ["left", "center", "right"].includes(cell.alignment?.horizontal ?? "")
    ? (cell.alignment.horizontal as "left" | "center" | "right")
    : undefined
  const vertical = ["top", "middle", "bottom"].includes(cell.alignment?.vertical ?? "")
    ? (cell.alignment.vertical as "top" | "middle" | "bottom")
    : undefined
  const style: WorkbookCellStyle = {
    ...(cell.numFmt && cell.numFmt !== "General" ? { numberFormat: cell.numFmt } : {}),
    ...(cell.font?.bold || cell.font?.italic || fontColor?.argb
      ? {
          font: {
            ...(cell.font.bold ? { bold: true } : {}),
            ...(cell.font.italic ? { italic: true } : {}),
            ...(fontColor?.argb ? { color: fontColor.argb } : {}),
          },
        }
      : {}),
    ...(fill?.type === "pattern" && fill.fgColor?.argb
      ? { fill: { color: fill.fgColor.argb } }
      : {}),
    ...(horizontal || vertical || cell.alignment?.wrapText !== undefined
      ? {
          alignment: {
            ...(horizontal ? { horizontal } : {}),
            ...(vertical ? { vertical } : {}),
            ...(cell.alignment.wrapText !== undefined ? { wrapText: cell.alignment.wrapText } : {}),
          },
        }
      : {}),
  }
  return Object.keys(style).length ? style : undefined
}

export function importDelimitedWorkbook(content: string, title: string): WorkbookDocument {
  const binary = XLSX.read(content, { type: "string", raw: false, cellFormula: true })
  return {
    schemaVersion: WORKBOOK_SCHEMA_VERSION,
    title: title.trim() || "Workbook",
    sheets: binary.SheetNames.map((sheetName, index) =>
      importSheet(binary.Sheets[sheetName], sheetName, index)
    ),
    unsupportedFeatures: [],
    recalculateOnOpen: true,
  }
}

export async function exportWorkbookXlsx(document: WorkbookDocument): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = "Cognia Office"
  workbook.created = new Date()
  workbook.modified = new Date()
  workbook.calcProperties.fullCalcOnLoad = true
  for (const sheet of document.sheets) writeSheet(workbook, sheet)
  const output = await workbook.xlsx.writeBuffer()
  return new Uint8Array(output)
}

function importSheet(sheet: WorkSheet, title: string, index: number): WorkbookSheet {
  const cells: Record<string, WorkbookCell> = {}
  for (const ref of Object.keys(sheet)) {
    if (ref.startsWith("!")) continue
    const cell = sheet[ref]
    if (!cell) continue
    cells[ref] = {
      type: importCellType(cell.t, cell.v),
      ...(cell.v !== undefined ? { value: importCellValue(cell.v) } : {}),
      ...(cell.f ? { formula: cell.f } : {}),
      ...(importStyle(cell) ? { style: importStyle(cell) } : {}),
    }
  }
  const freeze = (sheet as WorkSheet & { "!freeze"?: { xSplit?: number; ySplit?: number } })[
    "!freeze"
  ]
  return {
    id: `sheet-${index + 1}`,
    title,
    cells,
    merges: (sheet["!merges"] ?? []).map((range) => XLSX.utils.encode_range(range)),
    ...(sheet["!autofilter"]?.ref ? { filter: sheet["!autofilter"].ref } : {}),
    ...(freeze ? { freeze: { rows: freeze.ySplit ?? 0, columns: freeze.xSplit ?? 0 } } : {}),
    ...(sheet["!rows"]
      ? {
          rowDimensions: Object.fromEntries(
            sheet["!rows"].flatMap((row, rowIndex) =>
              row ? [[String(rowIndex + 1), { height: row.hpt, hidden: row.hidden }]] : []
            )
          ),
        }
      : {}),
    ...(sheet["!cols"]
      ? {
          columnDimensions: Object.fromEntries(
            sheet["!cols"].flatMap((column, columnIndex) =>
              column
                ? [
                    [
                      XLSX.utils.encode_col(columnIndex),
                      { width: column.wch, hidden: column.hidden },
                    ],
                  ]
                : []
            )
          ),
        }
      : {}),
  }
}

function writeSheet(workbook: ExcelJS.Workbook, sheet: WorkbookSheet): void {
  const worksheet = workbook.addWorksheet(sheet.title, {
    views: sheet.freeze
      ? [{ state: "frozen", xSplit: sheet.freeze.columns ?? 0, ySplit: sheet.freeze.rows ?? 0 }]
      : undefined,
  })
  for (const [ref, source] of Object.entries(sheet.cells)) {
    const cell = worksheet.getCell(ref)
    if (source.formula) {
      const result = toExcelValue(source)
      cell.value = { formula: source.formula, ...(result !== null ? { result } : {}) }
    } else {
      cell.value = toExcelValue(source)
    }
    applyStyle(cell, source.style)
  }
  for (const merge of sheet.merges) worksheet.mergeCells(merge)
  if (sheet.filter) worksheet.autoFilter = sheet.filter
  for (const [row, dimension] of Object.entries(sheet.rowDimensions ?? {})) {
    const target = worksheet.getRow(Number(row))
    if (dimension.height !== undefined) target.height = dimension.height
    if (dimension.hidden !== undefined) target.hidden = dimension.hidden
  }
  for (const [column, dimension] of Object.entries(sheet.columnDimensions ?? {})) {
    const target = worksheet.getColumn(column)
    if (dimension.width !== undefined) target.width = dimension.width
    if (dimension.hidden !== undefined) target.hidden = dimension.hidden
  }
}

function toExcelValue(
  cell: WorkbookCell
): null | string | number | boolean | Date | ExcelJS.CellErrorValue {
  if (cell.type === "blank" || cell.value === undefined) return null
  if (cell.type === "date") return new Date(String(cell.value))
  if (cell.type === "error") return { error: String(cell.value) as ExcelJS.ErrorValue }
  return cell.value
}

function applyStyle(cell: ExcelJS.Cell, style: WorkbookCellStyle | undefined): void {
  if (!style) return
  if (style.numberFormat) cell.numFmt = style.numberFormat
  if (style.font)
    cell.font = {
      bold: style.font.bold,
      italic: style.font.italic,
      ...(style.font.color ? { color: { argb: color(style.font.color) } } : {}),
    }
  if (style.fill)
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: color(style.fill.color) } }
  if (style.alignment)
    cell.alignment = {
      horizontal: style.alignment.horizontal,
      vertical: style.alignment.vertical === "middle" ? "middle" : style.alignment.vertical,
      wrapText: style.alignment.wrapText,
    }
}

function importCellType(type: string | undefined, value: unknown): WorkbookCell["type"] {
  if (value instanceof Date || type === "d") return "date"
  if (type === "n") return "number"
  if (type === "b") return "boolean"
  if (type === "e") return "error"
  if (type === "z" || value == null) return "blank"
  return "string"
}

function importCellValue(value: unknown): string | number | boolean {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return value
  return String(value)
}

function importStyle(cell: XLSX.CellObject): WorkbookCellStyle | undefined {
  const source = cell.s as unknown as
    | {
        font?: { bold?: boolean; italic?: boolean; color?: { rgb?: string } }
        fill?: { fgColor?: { rgb?: string } }
        alignment?: WorkbookCellStyle["alignment"]
      }
    | undefined
  const style: WorkbookCellStyle = {
    ...(cell.z ? { numberFormat: String(cell.z) } : {}),
    ...(source?.font
      ? {
          font: {
            bold: source.font.bold,
            italic: source.font.italic,
            ...(source.font.color?.rgb ? { color: source.font.color.rgb } : {}),
          },
        }
      : {}),
    ...(source?.fill?.fgColor?.rgb ? { fill: { color: source.fill.fgColor.rgb } } : {}),
    ...(source?.alignment ? { alignment: source.alignment } : {}),
  }
  return Object.keys(style).length ? style : undefined
}

async function detectUnsupportedFeatures(bytes: Uint8Array, workbook: WorkBook): Promise<string[]> {
  const warnings: string[] = []
  if (workbook.vbaraw)
    warnings.push("Macros are present and will not be preserved when this workbook is exported.")
  try {
    const zip = await JSZip.loadAsync(bytes)
    const paths = Object.keys(zip.files)
    if (paths.some((path) => path.startsWith("xl/pivotTables/")))
      warnings.push("Pivot tables are present and cannot be edited or preserved losslessly.")
    if (paths.some((path) => path.startsWith("xl/charts/")))
      warnings.push("Complex charts are present and cannot be edited or preserved losslessly.")
    if (paths.some((path) => path.startsWith("xl/externalLinks/")))
      warnings.push("External workbook links are present and will not be preserved.")
  } catch {
    warnings.push("The workbook package could not be inspected for unsupported OOXML features.")
  }
  return warnings
}

function color(value: string): string {
  const hex = value.replace(/^#/, "").toUpperCase()
  return hex.length === 6 ? `FF${hex}` : hex
}
