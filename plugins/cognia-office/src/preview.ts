import * as XLSX from "xlsx"
import type { ArtifactRenderer } from "@cognia/plugin-sdk"
import { parseWorkbook, validateWorkbook, type WorkbookCell, type WorkbookDocument } from "./model"

interface PreviewLabels {
  sheets: string
  validation: string
  empty: string
}

export function createWorkbookRenderer(labels: PreviewLabels): ArtifactRenderer {
  return {
    name: "Cognia Office Workbook",
    mount: (artifact, container) => {
      let activeSheet = 0
      let current = parseWorkbook(artifact.content)
      const render = () =>
        renderWorkbook(
          container,
          current,
          activeSheet,
          (index) => {
            activeSheet = index
            render()
          },
          labels
        )
      render()
      return {
        update: (updatedArtifact) => {
          current = parseWorkbook(updatedArtifact.content)
          activeSheet = Math.min(activeSheet, current.sheets.length - 1)
          render()
        },
        dispose: () => container.replaceChildren(),
      }
    },
  }
}

function renderWorkbook(
  container: HTMLElement,
  workbook: WorkbookDocument,
  activeSheet: number,
  selectSheet: (index: number) => void,
  labels: PreviewLabels
): void {
  container.replaceChildren()
  const root = document.createElement("section")
  root.style.cssText =
    "display:flex;flex-direction:column;min-height:100%;background:var(--background);color:var(--foreground)"
  const findings = validateWorkbook(workbook)
  if (findings.length) {
    const validation = document.createElement("div")
    validation.setAttribute("role", "status")
    validation.style.cssText =
      "padding:8px 12px;border-bottom:1px solid var(--border);font-size:12px;color:var(--muted-foreground)"
    const heading = document.createElement("strong")
    heading.textContent = labels.validation
    validation.appendChild(heading)
    const list = document.createElement("ul")
    list.style.cssText = "display:grid;gap:4px;margin-top:4px"
    for (const finding of findings) {
      const item = document.createElement("li")
      item.dataset.severity = finding.severity
      item.style.color =
        finding.severity === "error" ? "var(--destructive)" : "var(--muted-foreground)"
      const location = [finding.sheet, finding.cell].filter(Boolean).join("!")
      item.textContent = `${location ? `${location}: ` : ""}${finding.message} ${finding.remediation}`
      list.appendChild(item)
    }
    validation.appendChild(list)
    root.appendChild(validation)
  }
  const tabs = document.createElement("nav")
  tabs.setAttribute("aria-label", labels.sheets)
  tabs.style.cssText =
    "display:flex;gap:4px;padding:8px;border-bottom:1px solid var(--border);overflow:auto"
  workbook.sheets.forEach((sheet, index) => {
    const button = document.createElement("button")
    button.type = "button"
    button.textContent = sheet.title
    button.setAttribute("aria-pressed", String(index === activeSheet))
    button.style.cssText = `padding:4px 10px;border:1px solid var(--border);border-radius:6px;background:${index === activeSheet ? "var(--accent)" : "transparent"};white-space:nowrap`
    button.addEventListener("click", () => selectSheet(index))
    tabs.appendChild(button)
  })
  root.appendChild(tabs)
  root.appendChild(renderSheet(workbook.sheets[activeSheet], labels.empty))
  container.appendChild(root)
}

function renderSheet(sheet: WorkbookDocument["sheets"][number], emptyLabel: string): HTMLElement {
  const viewport = document.createElement("div")
  viewport.style.cssText = "overflow:auto;max-width:100%;padding:8px"
  const refs = Object.keys(sheet.cells)
  if (!refs.length) {
    viewport.textContent = emptyLabel
    return viewport
  }
  const coordinates = refs.map(XLSX.utils.decode_cell)
  const maxRow = Math.max(...coordinates.map((coord) => coord.r))
  const maxColumn = Math.max(...coordinates.map((coord) => coord.c))
  const mergeMap = createMergeMap(sheet.merges)
  const table = document.createElement("table")
  table.style.cssText = "border-collapse:collapse;font-size:13px;min-width:max-content"
  const body = document.createElement("tbody")
  for (let row = 0; row <= maxRow; row += 1) {
    const tr = document.createElement("tr")
    const rowDimension = sheet.rowDimensions?.[String(row + 1)]
    if (rowDimension?.height) tr.style.height = `${rowDimension.height}px`
    if (rowDimension?.hidden) tr.hidden = true
    for (let column = 0; column <= maxColumn; column += 1) {
      const ref = XLSX.utils.encode_cell({ r: row, c: column })
      const merge = mergeMap.get(ref)
      if (merge?.skip) continue
      const td = document.createElement("td")
      td.style.cssText =
        "border:1px solid var(--border);padding:4px 6px;min-width:72px;max-width:320px;white-space:pre-wrap"
      const columnDimension = sheet.columnDimensions?.[XLSXColumn(column)]
      if (columnDimension?.width) td.style.minWidth = `${Math.max(24, columnDimension.width * 7)}px`
      if (columnDimension?.hidden) td.hidden = true
      if (merge) {
        td.rowSpan = merge.rowSpan
        td.colSpan = merge.colSpan
      }
      applyCellStyle(td, sheet.cells[ref]?.style)
      td.textContent = displayValue(sheet.cells[ref])
      tr.appendChild(td)
    }
    body.appendChild(tr)
  }
  table.appendChild(body)
  viewport.appendChild(table)
  return viewport
}

function displayValue(cell: WorkbookCell | undefined): string {
  if (!cell) return ""
  if (cell.formula) return `=${cell.formula}`
  return cell.value === undefined ? "" : String(cell.value)
}

function applyCellStyle(element: HTMLElement, style: WorkbookCell["style"]): void {
  if (!style) return
  if (style.font?.bold) element.style.fontWeight = "700"
  if (style.font?.italic) element.style.fontStyle = "italic"
  if (style.font?.color) element.style.color = cssColor(style.font.color)
  if (style.fill?.color) element.style.backgroundColor = cssColor(style.fill.color)
  if (style.alignment?.horizontal) element.style.textAlign = style.alignment.horizontal
  if (style.alignment?.vertical) element.style.verticalAlign = style.alignment.vertical
  if (style.alignment?.wrapText === false) element.style.whiteSpace = "nowrap"
}

function createMergeMap(ranges: string[]) {
  const map = new Map<string, { skip: boolean; rowSpan: number; colSpan: number }>()
  for (const ref of ranges) {
    const range = XLSX.utils.decode_range(ref)
    for (let row = range.s.r; row <= range.e.r; row += 1) {
      for (let column = range.s.c; column <= range.e.c; column += 1) {
        map.set(XLSX.utils.encode_cell({ r: row, c: column }), {
          skip: row !== range.s.r || column !== range.s.c,
          rowSpan: range.e.r - range.s.r + 1,
          colSpan: range.e.c - range.s.c + 1,
        })
      }
    }
  }
  return map
}

function cssColor(value: string): string {
  const clean = value.replace(/^#/, "")
  return clean.length === 8 ? `#${clean.slice(2)}` : `#${clean}`
}

function XLSXColumn(index: number): string {
  let value = index + 1
  let result = ""
  while (value > 0) {
    value -= 1
    result = String.fromCharCode(65 + (value % 26)) + result
    value = Math.floor(value / 26)
  }
  return result
}
