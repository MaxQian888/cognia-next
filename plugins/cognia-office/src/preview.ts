import type { ArtifactRenderer } from "@cognia/plugin-sdk"
import { decodeCell, decodeRange, encodeCell, encodeColumn } from "./a1"
import {
  parseWorkbook,
  unsupportedFeatureId,
  validateWorkbook,
  type WorkbookCell,
  type WorkbookDocument,
  type WorkbookSheet,
  type WorkbookValidationFinding,
} from "./model"
import { loadSheetJs } from "./xlsx"

/** Resolves a plugin i18n key at render time so locale switches take effect. */
export type PreviewTranslator = (key: string, params?: Record<string, string | number>) => string

export interface WorkbookPreviewDeps {
  t: PreviewTranslator
  /** Called once per mount; must return a disposer. */
  onLocaleChange: (handler: () => void) => () => void
}

const ROW_HEADER_WIDTH = 46
const COLUMN_HEADER_HEIGHT = 24
const DEFAULT_COLUMN_WIDTH = 84
const DEFAULT_ROW_HEIGHT = 24
const MAX_PREVIEW_ROWS = 300
const MAX_PREVIEW_COLUMNS = 60

/**
 * SheetJS's number-format engine (SSF) is the only part of the spreadsheet
 * stack the preview needs. It loads with the first mounted workbook, not at
 * plugin activation; mounts render a loading line until it resolves.
 */
type NumberFormatter = (format: string, value: number) => string
let formatNumber: NumberFormatter | null = null
let formatterLoad: Promise<void> | null = null

export function preloadWorkbookPreviewEngine(): Promise<void> {
  formatterLoad ??= loadSheetJs().then(
    (sheetJs) => {
      formatNumber = (format, value) => sheetJs.SSF.format(format, value)
    },
    (error: unknown) => {
      // A failed chunk load must be retryable on the next mount.
      formatterLoad = null
      throw error
    }
  )
  return formatterLoad
}

let mountSequence = 0

const PREVIEW_STYLES = `
.copv { display:flex; flex-direction:column; height:100%; min-height:0; background:var(--background); color:var(--foreground); font-family:var(--font-sans); font-size:13px; }
.copv-findings { padding:6px 10px; border-bottom:1px solid var(--border); font-size:12px; color:var(--muted-foreground); max-height:96px; overflow:auto; }
.copv-findings strong { font-weight:600; }
.copv-findings ul { display:grid; gap:2px; margin-top:4px; padding-inline-start:4px; list-style:none; }
.copv-findings li { display:flex; gap:6px; align-items:baseline; }
.copv-findings li::before { content:""; flex:none; width:6px; height:6px; border-radius:50%; background:var(--info, var(--primary)); align-self:center; }
.copv-findings li[data-severity="warning"]::before { background:var(--warning, var(--primary)); }
.copv-findings li[data-severity="error"]::before { background:var(--destructive); }
.copv-findings li[data-severity="error"] { color:var(--destructive); }
.copv-findings li[data-severity="warning"] { color:var(--foreground); }
.copv-status { padding:24px; color:var(--muted-foreground); font-size:13px; text-align:center; }
.copv-status[role="alert"] { color:var(--destructive); }
.copv-empty { flex:1; display:grid; place-items:center; color:var(--muted-foreground); font-size:13px; padding:32px; text-align:center; }
.copv-grid { flex:1; min-height:0; overflow:auto; outline:none; }
.copv-grid:focus-visible { box-shadow:inset 0 0 0 2px var(--ring); }
.copv-table { border-collapse:separate; border-spacing:0; table-layout:fixed; font-size:12.5px; }
.copv-corner { position:sticky; top:0; left:0; z-index:5; background:var(--muted); border-right:1px solid var(--border); border-bottom:1px solid var(--border); }
.copv-colhdr { position:sticky; top:0; z-index:4; height:${COLUMN_HEADER_HEIGHT}px; background:var(--muted); color:var(--muted-foreground); font-weight:500; font-size:11px; text-align:center; border-right:1px solid var(--border); border-bottom:1px solid var(--border); user-select:none; overflow:hidden; }
.copv-rowhdr { position:sticky; left:0; z-index:3; width:${ROW_HEADER_WIDTH}px; min-width:${ROW_HEADER_WIDTH}px; background:var(--muted); color:var(--muted-foreground); font-weight:500; font-size:11px; text-align:center; border-right:1px solid var(--border); border-bottom:1px solid var(--border); user-select:none; }
.copv-cell { position:relative; padding:3px 6px; border-right:1px solid var(--border); border-bottom:1px solid var(--border); white-space:pre-wrap; overflow:hidden; text-overflow:ellipsis; background:var(--background); vertical-align:top; }
.copv-cell--num { font-variant-numeric:tabular-nums; }
.copv-cell--formula { color:var(--primary); }
.copv-cell--error { color:var(--destructive); font-weight:500; }
.copv-cell--frozen-r, .copv-cell--frozen-c { position:sticky; z-index:2; }
.copv-cell--frozen-rc { position:sticky; z-index:4; }
.copv-freeze-edge-r { border-bottom:2px solid var(--primary) !important; }
.copv-freeze-edge-c { border-right:2px solid var(--primary) !important; }
.copv-filtered::after { content:""; position:absolute; right:1px; bottom:1px; width:0; height:0; border:4px solid transparent; border-right-color:var(--primary); border-bottom-color:var(--primary); }
.copv-limited { padding:6px 12px; color:var(--muted-foreground); font-size:11.5px; border-top:1px solid var(--border); background:var(--muted); position:sticky; left:0; }
.copv-tabs { flex:none; display:flex; gap:2px; padding:0 8px; border-top:1px solid var(--border); background:var(--muted); overflow-x:auto; }
.copv-tab { display:inline-flex; align-items:center; gap:6px; min-height:28px; padding:6px 12px; margin:4px 0; border:1px solid transparent; border-radius:6px; background:transparent; color:var(--muted-foreground); font:inherit; font-size:12px; white-space:nowrap; cursor:pointer; transition:background-color .15s ease-out, color .15s ease-out; }
.copv-tab:focus-visible { outline:2px solid var(--ring); outline-offset:1px; }
@media (hover:hover) { .copv-tab:hover { background:var(--accent); color:var(--accent-foreground); } }
@media (pointer:coarse) { .copv-tab { min-height:36px; } }
@media (prefers-reduced-motion:reduce) { .copv-tab { transition:none; } }
.copv-tab[aria-selected="true"] { background:var(--background); color:var(--foreground); border-color:var(--border); font-weight:600; }
.copv-chip { padding:1px 6px; border-radius:999px; background:var(--accent); color:var(--accent-foreground); font-size:10px; font-weight:600; text-transform:uppercase; letter-spacing:0.4px; }
`

export function createWorkbookRenderer(deps: WorkbookPreviewDeps): ArtifactRenderer {
  return {
    name: deps.t("renderer.name"),
    mount: (artifact, container) => {
      const t = deps.t
      const mountId = ++mountSequence
      const style = document.createElement("style")
      style.textContent = PREVIEW_STYLES
      container.appendChild(style)
      const root = document.createElement("section")
      root.className = "copv"
      container.appendChild(root)

      let disposed = false
      let activeSheet = 0
      let renderedSheet = -1
      let content = artifact.content
      let loadError: string | undefined

      const render = () => {
        const focusKey = activeFocusKey(root)
        const scroller = root.querySelector<HTMLElement>(".copv-grid")
        // Keep the scroll position across an update or locale switch of the
        // same sheet; a newly selected sheet starts at its top-left.
        const scroll =
          scroller && renderedSheet === activeSheet
            ? { top: scroller.scrollTop, left: scroller.scrollLeft }
            : null
        if (loadError) {
          root.replaceChildren(statusLine(t("preview.loadError", { error: loadError }), true))
          return
        }
        if (!formatNumber) {
          root.replaceChildren(statusLine(t("preview.loading"), false))
          return
        }
        let workbook: WorkbookDocument
        try {
          workbook = parseWorkbook(content)
        } catch (error) {
          root.replaceChildren(
            statusLine(
              t("preview.parseError", {
                error: error instanceof Error ? error.message : String(error),
              }),
              true
            )
          )
          return
        }
        activeSheet = Math.max(0, Math.min(activeSheet, workbook.sheets.length - 1))
        renderedSheet = activeSheet
        renderWorkbook(root, workbook, activeSheet, t, mountId, (index, focus) => {
          activeSheet = index
          render()
          if (focus) focusTab(root, index)
        })
        const next = root.querySelector<HTMLElement>(".copv-grid")
        if (next && scroll) {
          next.scrollTop = scroll.top
          next.scrollLeft = scroll.left
        }
        restoreFocus(root, focusKey)
      }

      const disposeLocale = deps.onLocaleChange(render)
      render()
      if (!formatNumber) {
        preloadWorkbookPreviewEngine().then(
          () => {
            if (!disposed) render()
          },
          (error: unknown) => {
            loadError = error instanceof Error ? error.message : String(error)
            if (!disposed) render()
          }
        )
      }
      return {
        update: (updatedArtifact) => {
          content = updatedArtifact.content
          render()
        },
        dispose: () => {
          disposed = true
          disposeLocale()
          container.replaceChildren()
        },
      }
    },
  }
}

function statusLine(text: string, isError: boolean): HTMLElement {
  const line = document.createElement("p")
  line.className = "copv-status"
  line.setAttribute("role", isError ? "alert" : "status")
  line.textContent = text
  return line
}

/** The `data-focus-key` of the focused control inside `root`, if any. */
function activeFocusKey(root: HTMLElement): string | undefined {
  const active = root.ownerDocument.activeElement
  if (!(active instanceof HTMLElement) || !root.contains(active)) return undefined
  return active.dataset.focusKey
}

/** Re-renders replace the DOM; put keyboard focus back on the same control. */
function restoreFocus(root: HTMLElement, key: string | undefined): void {
  if (!key) return
  const target = [...root.querySelectorAll<HTMLElement>("[data-focus-key]")].find(
    (element) => element.dataset.focusKey === key
  )
  target?.focus({ preventScroll: true })
}

function focusTab(root: HTMLElement, index: number): void {
  root.querySelector<HTMLElement>(`[data-focus-key="sheet:${index}"]`)?.focus()
}

function renderWorkbook(
  root: HTMLElement,
  workbook: WorkbookDocument,
  activeSheet: number,
  t: PreviewTranslator,
  mountId: number,
  selectSheet: (index: number, moveFocus: boolean) => void
): void {
  root.replaceChildren()
  const findings = validateWorkbook(workbook)
  if (findings.length) root.appendChild(renderFindings(findings, t))

  const sheet = workbook.sheets[activeSheet]
  const panel = document.createElement("div")
  panel.className = "copv-panel"
  panel.style.cssText = "flex:1;min-height:0;display:flex;flex-direction:column"
  panel.id = `copv-panel-${mountId}`
  panel.setAttribute("role", "tabpanel")
  panel.setAttribute("aria-labelledby", `copv-tab-${mountId}-${activeSheet}`)
  if (sheet) {
    const { content, limited } = renderSheet(sheet, t)
    panel.appendChild(content)
    if (limited) {
      const notice = document.createElement("div")
      notice.className = "copv-limited"
      notice.setAttribute("role", "note")
      notice.textContent = limited
      panel.appendChild(notice)
    }
  } else {
    panel.appendChild(emptyState(t))
  }
  root.appendChild(panel)
  root.appendChild(renderTabs(workbook, activeSheet, t, mountId, selectSheet))
}

/** A finding in the active locale; unrecognised text stays as the model wrote it. */
export function localizeFinding(finding: WorkbookValidationFinding, t: PreviewTranslator): string {
  if (finding.code === "feature.unsupported") {
    const id = unsupportedFeatureId(finding.message)
    const message = id ? t(`feature.${id}`) : finding.message
    return `${message} ${t("finding.featureUnsupported.remediation")}`
  }
  return `${finding.message} ${finding.remediation}`
}

function renderFindings(findings: WorkbookValidationFinding[], t: PreviewTranslator): HTMLElement {
  const validation = document.createElement("div")
  validation.className = "copv-findings"
  validation.setAttribute("role", "status")
  const heading = document.createElement("strong")
  heading.textContent = `${t("preview.validation")} (${findings.length})`
  validation.appendChild(heading)
  const list = document.createElement("ul")
  for (const finding of findings) {
    const item = document.createElement("li")
    item.dataset.severity = finding.severity
    const location = [finding.sheet, finding.cell].filter(Boolean).join("!")
    const text = document.createElement("span")
    text.textContent = `${location ? `${location}: ` : ""}${localizeFinding(finding, t)}`
    item.appendChild(text)
    list.appendChild(item)
  }
  validation.appendChild(list)
  return validation
}

/**
 * WAI-ARIA tabs: one tab stop (roving tabindex), arrow keys / Home / End move
 * between sheets and select them.
 */
function renderTabs(
  workbook: WorkbookDocument,
  activeSheet: number,
  t: PreviewTranslator,
  mountId: number,
  selectSheet: (index: number, moveFocus: boolean) => void
): HTMLElement {
  const tabs = document.createElement("nav")
  tabs.className = "copv-tabs"
  tabs.setAttribute("role", "tablist")
  tabs.setAttribute("aria-label", t("preview.sheets"))
  const last = workbook.sheets.length - 1
  workbook.sheets.forEach((sheet, index) => {
    const button = document.createElement("button")
    button.type = "button"
    button.className = "copv-tab"
    button.id = `copv-tab-${mountId}-${index}`
    button.dataset.focusKey = `sheet:${index}`
    button.setAttribute("role", "tab")
    button.setAttribute("aria-selected", String(index === activeSheet))
    button.setAttribute("aria-controls", `copv-panel-${mountId}`)
    button.tabIndex = index === activeSheet ? 0 : -1
    const title = document.createElement("span")
    title.textContent = sheet.title
    button.appendChild(title)
    if (sheet.filter) {
      button.appendChild(chip(t("preview.filtered")))
      button.title = sheet.filter
    }
    if (sheet.freeze && ((sheet.freeze.rows ?? 0) > 0 || (sheet.freeze.columns ?? 0) > 0)) {
      button.appendChild(chip(t("preview.frozen")))
    }
    button.addEventListener("click", () => selectSheet(index, false))
    button.addEventListener("keydown", (event) => {
      const target =
        event.key === "ArrowRight"
          ? index === last
            ? 0
            : index + 1
          : event.key === "ArrowLeft"
            ? index === 0
              ? last
              : index - 1
            : event.key === "Home"
              ? 0
              : event.key === "End"
                ? last
                : null
      if (target === null) return
      event.preventDefault()
      selectSheet(target, true)
    })
    tabs.appendChild(button)
  })
  return tabs
}

function chip(text: string): HTMLElement {
  const el = document.createElement("span")
  el.className = "copv-chip"
  el.textContent = text
  return el
}

function emptyState(t: PreviewTranslator): HTMLElement {
  const el = document.createElement("div")
  el.className = "copv-empty"
  el.textContent = t("preview.empty")
  return el
}

interface SheetGeometry {
  rowCount: number
  columnCount: number
  totalRows: number
  totalColumns: number
  columnWidth: (column: number) => number
  rowHeight: (row: number) => number
  rowTop: (row: number) => number
  columnLeft: (column: number) => number
}

function sheetGeometry(sheet: WorkbookSheet): SheetGeometry {
  let maxRow = -1
  let maxColumn = -1
  for (const ref of Object.keys(sheet.cells)) {
    const match = /^([A-Z]+)(\d+)$/.exec(ref)
    if (!match) continue
    const cell = decodeCell(ref)
    maxRow = Math.max(maxRow, cell.r)
    maxColumn = Math.max(maxColumn, cell.c)
  }
  for (const merge of sheet.merges) {
    const range = decodeRange(merge)
    maxRow = Math.max(maxRow, range.e.r)
    maxColumn = Math.max(maxColumn, range.e.c)
  }
  const totalRows = maxRow + 1
  const totalColumns = maxColumn + 1
  const rowCount = Math.min(totalRows, MAX_PREVIEW_ROWS)
  const columnCount = Math.min(totalColumns, MAX_PREVIEW_COLUMNS)

  const columnWidth = (column: number) => {
    const dimension = sheet.columnDimensions?.[encodeColumn(column)]
    return dimension?.width
      ? Math.max(24, Math.min(400, dimension.width * 7))
      : DEFAULT_COLUMN_WIDTH
  }
  const rowHeight = (row: number) =>
    sheet.rowDimensions?.[String(row + 1)]?.height ?? DEFAULT_ROW_HEIGHT

  const frozenRows = Math.min(sheet.freeze?.rows ?? 0, rowCount)
  const frozenColumns = Math.min(sheet.freeze?.columns ?? 0, columnCount)
  const rowOffsets: number[] = [COLUMN_HEADER_HEIGHT]
  for (let r = 0; r < frozenRows; r += 1) rowOffsets.push(rowOffsets[r] + rowHeight(r))
  const columnOffsets: number[] = [ROW_HEADER_WIDTH]
  for (let c = 0; c < frozenColumns; c += 1) columnOffsets.push(columnOffsets[c] + columnWidth(c))

  return {
    rowCount,
    columnCount,
    totalRows,
    totalColumns,
    columnWidth,
    rowHeight,
    rowTop: (row) => rowOffsets[row] ?? COLUMN_HEADER_HEIGHT,
    columnLeft: (column) => columnOffsets[column] ?? ROW_HEADER_WIDTH,
  }
}

function renderSheet(
  sheet: WorkbookSheet,
  t: PreviewTranslator
): { content: HTMLElement; limited?: string } {
  const geometry = sheetGeometry(sheet)
  if (!geometry.rowCount || !geometry.columnCount) return { content: emptyState(t) }

  const viewport = document.createElement("div")
  viewport.className = "copv-grid"
  // A scrollable region must be reachable from the keyboard to be scrolled.
  viewport.tabIndex = 0
  viewport.dataset.focusKey = "grid"
  viewport.setAttribute("role", "region")
  viewport.setAttribute("aria-label", t("preview.grid", { name: sheet.title }))
  const frozenRows = Math.min(sheet.freeze?.rows ?? 0, geometry.rowCount)
  const frozenColumns = Math.min(sheet.freeze?.columns ?? 0, geometry.columnCount)
  const mergeMap = createMergeMap(sheet.merges)
  const filterRange = sheet.filter ? decodeRange(sheet.filter) : undefined

  const table = document.createElement("table")
  table.className = "copv-table"
  table.setAttribute("aria-label", sheet.title)

  const colgroup = document.createElement("colgroup")
  const rowHeaderCol = document.createElement("col")
  rowHeaderCol.style.width = `${ROW_HEADER_WIDTH}px`
  colgroup.appendChild(rowHeaderCol)
  for (let column = 0; column < geometry.columnCount; column += 1) {
    const col = document.createElement("col")
    col.style.width = `${geometry.columnWidth(column)}px`
    if (sheet.columnDimensions?.[encodeColumn(column)]?.hidden) col.hidden = true
    colgroup.appendChild(col)
  }
  table.appendChild(colgroup)

  const thead = document.createElement("thead")
  const headerRow = document.createElement("tr")
  const corner = document.createElement("th")
  corner.className = "copv-corner"
  corner.setAttribute("aria-label", t("preview.corner"))
  headerRow.appendChild(corner)
  for (let column = 0; column < geometry.columnCount; column += 1) {
    const th = document.createElement("th")
    th.className = "copv-colhdr"
    th.scope = "col"
    th.textContent = encodeColumn(column)
    if (column < frozenColumns) {
      th.style.left = `${geometry.columnLeft(column)}px`
      th.style.zIndex = "5"
    }
    if (frozenColumns > 0 && column === frozenColumns - 1) th.classList.add("copv-freeze-edge-c")
    headerRow.appendChild(th)
  }
  thead.appendChild(headerRow)
  table.appendChild(thead)

  const body = document.createElement("tbody")
  for (let row = 0; row < geometry.rowCount; row += 1) {
    const tr = document.createElement("tr")
    const rowDimension = sheet.rowDimensions?.[String(row + 1)]
    if (rowDimension?.hidden) {
      tr.hidden = true
      body.appendChild(tr)
      continue
    }
    if (rowDimension?.height || row < frozenRows) tr.style.height = `${geometry.rowHeight(row)}px`

    const rowHeader = document.createElement("th")
    rowHeader.className = "copv-rowhdr"
    rowHeader.scope = "row"
    rowHeader.textContent = String(row + 1)
    if (row < frozenRows) {
      rowHeader.style.top = `${geometry.rowTop(row)}px`
      rowHeader.style.zIndex = "4"
    }
    if (frozenRows > 0 && row === frozenRows - 1) rowHeader.classList.add("copv-freeze-edge-r")
    tr.appendChild(rowHeader)

    for (let column = 0; column < geometry.columnCount; column += 1) {
      const ref = encodeCell({ r: row, c: column })
      const merge = mergeMap.get(ref)
      if (merge?.skip) continue
      const td = document.createElement("td")
      td.className = "copv-cell"
      td.dataset.ref = ref
      if (merge) {
        td.rowSpan = merge.rowSpan
        td.colSpan = merge.colSpan
      }
      const frozenR = row < frozenRows
      const frozenC = column < frozenColumns
      if (frozenR) td.style.top = `${geometry.rowTop(row)}px`
      if (frozenC) td.style.left = `${geometry.columnLeft(column)}px`
      if (frozenR && frozenC) td.classList.add("copv-cell--frozen-rc")
      else if (frozenR) td.classList.add("copv-cell--frozen-r")
      else if (frozenC) td.classList.add("copv-cell--frozen-c")
      if (frozenRows > 0 && row === frozenRows - 1) td.classList.add("copv-freeze-edge-r")
      if (frozenColumns > 0 && column === frozenColumns - 1) td.classList.add("copv-freeze-edge-c")
      if (
        filterRange &&
        row === filterRange.s.r &&
        column >= filterRange.s.c &&
        column <= filterRange.e.c
      )
        td.classList.add("copv-filtered")
      if (row < frozenRows) td.style.height = `${geometry.rowHeight(row)}px`
      renderCellContent(td, sheet.cells[ref])
      tr.appendChild(td)
    }
    body.appendChild(tr)
  }
  table.appendChild(body)
  viewport.appendChild(table)

  const parts: string[] = []
  if (geometry.totalRows > geometry.rowCount)
    parts.push(
      t("preview.truncatedRows", {
        count: geometry.rowCount,
        total: geometry.totalRows,
      })
    )
  if (geometry.totalColumns > geometry.columnCount)
    parts.push(
      t("preview.truncatedColumns", {
        count: geometry.columnCount,
        total: geometry.totalColumns,
      })
    )
  return { content: viewport, limited: parts.length ? parts.join(" · ") : undefined }
}

function renderCellContent(td: HTMLElement, cell: WorkbookCell | undefined): void {
  if (!cell) return
  if (cell.type === "error") td.classList.add("copv-cell--error")
  if (cell.type === "number" || cell.type === "date") td.classList.add("copv-cell--num")
  applyCellStyle(td, cell.style)
  if (cell.formula) {
    td.classList.add("copv-cell--formula")
    td.title = `=${cell.formula}`
    if (cell.value === undefined) {
      td.textContent = `=${cell.formula}`
      return
    }
  }
  td.textContent = displayValue(cell)
}

function displayValue(cell: WorkbookCell): string {
  const format = cell.style?.numberFormat
  if (cell.type === "date") {
    const date = new Date(String(cell.value))
    if (Number.isNaN(date.getTime())) return String(cell.value)
    return formatDate(date, format)
  }
  if (cell.type === "number" && format && formatNumber) {
    try {
      return formatNumber(format, cell.value as number)
    } catch {
      return String(cell.value)
    }
  }
  return cell.value === undefined ? "" : String(cell.value)
}

function formatDate(date: Date, format: string | undefined): string {
  if (format && formatNumber) {
    try {
      return formatNumber(format, toSerial(date))
    } catch {
      // fall through to ISO formatting
    }
  }
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** Excel serial for a JS Date, matching SheetJS' default 1900 date system. */
function toSerial(date: Date): number {
  const epoch = Date.UTC(1899, 11, 30)
  return (date.getTime() - epoch - date.getTimezoneOffset() * 60000) / 86400000
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
    const range = decodeRange(ref)
    if (range.s.r < 0 || range.s.c < 0) continue
    for (let row = range.s.r; row <= range.e.r; row += 1) {
      for (let column = range.s.c; column <= range.e.c; column += 1) {
        map.set(encodeCell({ r: row, c: column }), {
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
