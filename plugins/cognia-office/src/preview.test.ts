/** @jest-environment jsdom */

import * as XLSX from "xlsx"
import type { Artifact } from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"
import {
  applyWorkbookOperations,
  createWorkbook,
  UNSUPPORTED_FEATURES,
  WORKBOOK_ARTIFACT_KIND,
} from "./model"
import {
  createWorkbookRenderer as createRenderer,
  preloadWorkbookPreviewEngine,
  type PreviewTranslator,
} from "./preview"

const LOCALES = manifestJson.i18n.locales as Record<string, Record<string, string>>

function artifact(content: string): Artifact {
  return {
    id: "a1",
    sessionId: "s1",
    messageId: "m1",
    type: "code",
    title: "Workbook",
    content,
    language: "json",
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    metadata: {
      plugin: { kind: WORKBOOK_ARTIFACT_KIND, schemaVersion: 1, ownerPluginId: "cognia-office" },
    },
  }
}

function translator(
  overrides: Record<string, string> = {},
  locale = "en"
): jest.MockedFunction<PreviewTranslator> {
  const labels: Record<string, string> = {
    ...LOCALES.en,
    ...LOCALES[locale],
    "preview.sheets": "Sheets",
    "preview.empty": "Empty",
    "preview.truncatedRows": "first {count} of {total} rows",
    "preview.truncatedColumns": "first {count} of {total} columns",
    ...overrides,
  }
  return jest.fn((key, params) => {
    let text = labels[key] ?? key
    for (const [name, value] of Object.entries(params ?? {}))
      text = text.replaceAll(`{${name}}`, String(value))
    return text
  })
}

function createWorkbookRenderer(t: PreviewTranslator, onLocaleChange = () => () => {}) {
  return createRenderer({ t, onLocaleChange })
}

beforeAll(async () => {
  await preloadWorkbookPreviewEngine()
})

afterEach(() => document.body.replaceChildren())

it("renders sheet tabs, row and column headers, formulas, and updates in place", () => {
  const first = applyWorkbookOperations(createWorkbook("PnL", "Trades"), [
    {
      op: "setCell",
      sheet: "Trades",
      cell: "A1",
      value: { type: "number", formula: "1+1", value: 2, style: { font: { bold: true } } },
    },
    { op: "addSheet", title: "Summary" },
  ])
  const container = document.createElement("div")
  const handle = createWorkbookRenderer(translator()).mount(
    artifact(JSON.stringify(first)),
    container
  )
  expect(container.textContent).toContain("Trades")
  expect(container.textContent).toContain("Summary")
  // Column letters and row numbers are rendered as spreadsheet headers.
  expect(container.querySelector(".copv-colhdr")).toHaveTextContent("A")
  expect(container.querySelector(".copv-rowhdr")).toHaveTextContent("1")
  // A formula cell shows the cached value and keeps the formula on the title.
  const cell = container.querySelector<HTMLTableCellElement>('td[data-ref="A1"]')
  expect(cell).toHaveTextContent("2")
  expect(cell?.title).toBe("=1+1")
  expect(cell?.className).toContain("copv-cell--formula")
  expect(cell?.style.fontWeight).toBe("700")

  const updated = applyWorkbookOperations(first, [
    { op: "setCell", sheet: "Summary", cell: "A1", value: { type: "string", value: "Ready" } },
  ])
  handle.update?.(artifact(JSON.stringify(updated)))
  ;(
    Array.from(container.querySelectorAll(".copv-tab")).find(
      (button) => button.textContent === "Summary"
    ) as HTMLButtonElement
  ).click()
  expect(container.textContent).toContain("Ready")
  handle.dispose()
  expect(container).toBeEmptyDOMElement()
})

it("renders validation severity, location, and remediation", () => {
  const workbook = createWorkbook("Warnings", "Data")
  workbook.unsupportedFeatures.push("External links will not be preserved.")
  const container = document.createElement("div")
  const handle = createWorkbookRenderer(translator()).mount(
    artifact(JSON.stringify(workbook)),
    container
  )

  expect(container.querySelector('[data-severity="warning"]')).toHaveTextContent(
    "External links will not be preserved."
  )
  expect(container.textContent).toContain("confirming")
  handle.dispose()
})

it("localizes known unsupported-feature warnings and re-renders on a locale switch", () => {
  const workbook = createWorkbook("Warnings", "Data")
  workbook.unsupportedFeatures.push(UNSUPPORTED_FEATURES.pivotTables)
  let locale = "en"
  let onLocale: () => void = () => {}
  const t = jest.fn((key: string) => LOCALES[locale][key] ?? key) as PreviewTranslator
  const container = document.createElement("div")
  createRenderer({
    t,
    onLocaleChange: (handler) => {
      onLocale = handler
      return () => {}
    },
  }).mount(artifact(JSON.stringify(workbook)), container)
  expect(container.querySelector('[data-severity="warning"]')).toHaveTextContent(
    UNSUPPORTED_FEATURES.pivotTables
  )
  locale = "zh-CN"
  onLocale()
  expect(container.querySelector('[data-severity="warning"]')).toHaveTextContent(
    "包含数据透视表，无法编辑或无损保留。"
  )
  expect(container.querySelector(".copv-tabs")).toHaveAttribute("aria-label", "工作表")
})

it("names the renderer through the translator", () => {
  expect(createWorkbookRenderer(translator()).name).toBe("Cognia Office Workbook")
})

it("shows a localized error instead of throwing on an invalid artifact", () => {
  const container = document.createElement("div")
  expect(() =>
    createWorkbookRenderer(translator()).mount(artifact("{not json"), container)
  ).not.toThrow()
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    "This artifact is not a valid Cognia workbook"
  )
})

it("moves between sheets with the arrow keys and keeps focus on the selected tab", () => {
  const workbook = applyWorkbookOperations(createWorkbook("Keys", "One"), [
    { op: "addSheet", title: "Two" },
    { op: "addSheet", title: "Three" },
  ])
  const container = document.createElement("div")
  document.body.appendChild(container)
  createWorkbookRenderer(translator()).mount(artifact(JSON.stringify(workbook)), container)
  const tabs = () => [...container.querySelectorAll<HTMLButtonElement>(".copv-tab")]
  expect(tabs().map((tab) => tab.tabIndex)).toEqual([0, -1, -1])
  tabs()[0].focus()
  tabs()[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }))
  expect(tabs()[1]).toHaveAttribute("aria-selected", "true")
  expect(document.activeElement).toBe(tabs()[1])
  tabs()[1].dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }))
  expect(document.activeElement).toBe(tabs()[2])
  tabs()[2].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }))
  expect(document.activeElement).toBe(tabs()[0])
  const panel = container.querySelector('[role="tabpanel"]')!
  expect(tabs()[0].getAttribute("aria-controls")).toBe(panel.id)
})

it("keeps focus on the focused sheet tab across artifact updates", () => {
  const workbook = applyWorkbookOperations(createWorkbook("Focus", "One"), [
    { op: "addSheet", title: "Two" },
  ])
  const container = document.createElement("div")
  document.body.appendChild(container)
  const handle = createWorkbookRenderer(translator()).mount(
    artifact(JSON.stringify(workbook)),
    container
  )
  container.querySelectorAll<HTMLButtonElement>(".copv-tab")[1].click()
  container.querySelectorAll<HTMLButtonElement>(".copv-tab")[1].focus()
  const updated = applyWorkbookOperations(workbook, [
    { op: "setCell", sheet: "Two", cell: "A1", value: { type: "string", value: "new" } },
  ])
  handle.update?.(artifact(JSON.stringify(updated)))
  expect(document.activeElement).toBe(container.querySelectorAll(".copv-tab")[1])
  const grid = container.querySelector(".copv-grid")
  expect(grid).toHaveAttribute("tabindex", "0")
  expect(grid).toHaveAttribute("aria-label", "Sheet Two")
})

it("ships touch-sized, focus-visible, reduced-motion-aware tab styles", () => {
  const container = document.createElement("div")
  createWorkbookRenderer(translator()).mount(
    artifact(JSON.stringify(createWorkbook("Styles"))),
    container
  )
  const css = container.querySelector("style")?.textContent ?? ""
  expect(css).toContain("@media (pointer:coarse) { .copv-tab { min-height:36px; } }")
  expect(css).toContain(".copv-tab:focus-visible")
  expect(css).toContain("@media (hover:hover)")
  expect(css).toContain("prefers-reduced-motion")
})

it("renders empty sheets and clamps the active tab after an update", () => {
  const workbook = applyWorkbookOperations(createWorkbook("Empty", "First"), [
    { op: "addSheet", title: "Second" },
  ])
  const container = document.createElement("div")
  const handle = createWorkbookRenderer(translator()).mount(
    artifact(JSON.stringify(workbook)),
    container
  )

  expect(container.querySelector("nav")).toHaveAttribute("aria-label", "Sheets")
  expect(container).toHaveTextContent("Empty")
  ;(container.querySelectorAll(".copv-tab")[1] as HTMLButtonElement).click()
  const oneSheet = applyWorkbookOperations(workbook, [{ op: "deleteSheet", sheet: "First" }])
  handle.update?.(artifact(JSON.stringify(oneSheet)))
  expect(container.querySelectorAll(".copv-tab")).toHaveLength(1)
  expect(container.querySelector(".copv-tab")).toHaveAttribute("aria-selected", "true")
})

it("renders merges, dimensions, all basic styles, blank values, and cell locations", () => {
  const workbook = applyWorkbookOperations(createWorkbook("Styled", "Data"), [
    {
      op: "setCell",
      sheet: "Data",
      cell: "A1",
      value: {
        type: "string",
        value: "Styled",
        style: {
          font: { bold: true, italic: true, color: "FF112233" },
          fill: { color: "#445566" },
          alignment: { horizontal: "right", vertical: "bottom", wrapText: false },
        },
      },
    },
    { op: "setCell", sheet: "Data", cell: "C2", value: { type: "blank" } },
    { op: "merge", sheet: "Data", range: "A1:B1" },
    { op: "setRowDimension", sheet: "Data", row: 2, height: 25, hidden: true },
    { op: "setColumnDimension", sheet: "Data", column: "A", width: 2 },
    { op: "setColumnDimension", sheet: "Data", column: "C", hidden: true },
  ])
  workbook.unsupportedFeatures.push("Feature loss warning")
  const container = document.createElement("div")
  createWorkbookRenderer(translator()).mount(artifact(JSON.stringify(workbook)), container)

  const cells = container.querySelectorAll("td")
  const first = cells[0] as HTMLTableCellElement
  expect(first).toMatchObject({ rowSpan: 1, colSpan: 2 })
  expect(first.style).toMatchObject({
    fontWeight: "700",
    fontStyle: "italic",
    color: "rgb(17, 34, 51)",
    backgroundColor: "rgb(68, 85, 102)",
    textAlign: "right",
    verticalAlign: "bottom",
    whiteSpace: "nowrap",
  })
  // Column widths/hidden state live on <col>; hidden rows on <tr>.
  const cols = container.querySelectorAll("col")
  expect((cols[1] as HTMLTableColElement).style.width).toBe("24px")
  expect(cols[3].hasAttribute("hidden")).toBe(true)
  const bodyRows = container.querySelectorAll("tbody tr")
  expect(bodyRows[1]).toHaveAttribute("hidden")
  expect(container.querySelector('[data-severity="warning"]')).toHaveTextContent(
    "Feature loss warning"
  )
})

it("marks frozen panes and filtered headers, and badges the sheet tab", () => {
  const workbook = applyWorkbookOperations(createWorkbook("Pinned", "Data"), [
    {
      op: "setRange",
      sheet: "Data",
      range: "A1:C3",
      values: [
        [
          { type: "string", value: "h1" },
          { type: "string", value: "h2" },
          { type: "string", value: "h3" },
        ],
        [
          { type: "number", value: 1 },
          { type: "number", value: 2 },
          { type: "number", value: 3 },
        ],
        [
          { type: "number", value: 4 },
          { type: "number", value: 5 },
          { type: "number", value: 6 },
        ],
      ],
    },
    { op: "setFreeze", sheet: "Data", rows: 1, columns: 1 },
    { op: "setFilter", sheet: "Data", range: "A1:C3" },
  ])
  const container = document.createElement("div")
  createWorkbookRenderer(translator()).mount(artifact(JSON.stringify(workbook)), container)

  const a1 = container.querySelector<HTMLElement>('td[data-ref="A1"]')!
  expect(a1.className).toContain("copv-cell--frozen-rc")
  expect(a1.className).toContain("copv-freeze-edge-r")
  expect(a1.className).toContain("copv-freeze-edge-c")
  expect(a1.className).toContain("copv-filtered")
  expect(a1.style.top).toBe("24px")
  expect(a1.style.left).toBe("46px")

  const c3 = container.querySelector<HTMLElement>('td[data-ref="C3"]')!
  expect(c3.className).not.toContain("frozen")

  const tab = container.querySelector<HTMLElement>(".copv-tab")!
  expect(tab.textContent).toContain("Filtered")
  expect(tab.textContent).toContain("Frozen")
})

it("formats numbers and dates through their number formats", () => {
  const workbook = applyWorkbookOperations(createWorkbook("Formats", "Data"), [
    {
      op: "setCell",
      sheet: "Data",
      cell: "A1",
      value: { type: "number", value: 1234.5, style: { numberFormat: "#,##0.00" } },
    },
    {
      op: "setCell",
      sheet: "Data",
      cell: "A2",
      value: { type: "date", value: "2026-08-08T12:00:00.000Z" },
    },
    { op: "setCell", sheet: "Data", cell: "A3", value: { type: "error", value: "#DIV/0!" } },
  ])
  const container = document.createElement("div")
  createWorkbookRenderer(translator()).mount(artifact(JSON.stringify(workbook)), container)

  expect(container.querySelector('td[data-ref="A1"]')).toHaveTextContent("1,234.50")
  expect(container.querySelector('td[data-ref="A2"]')).toHaveTextContent("2026-08-08")
  const error = container.querySelector<HTMLElement>('td[data-ref="A3"]')!
  expect(error).toHaveTextContent("#DIV/0!")
  expect(error.className).toContain("copv-cell--error")
})

it("caps rendering for very large workbooks and reports the truncation", () => {
  const workbook = createWorkbook("Huge", "Data")
  for (let row = 0; row < 350; row += 1) {
    for (let column = 0; column < 70; column += 1) {
      const ref = `${XLSX.utils.encode_col(column)}${row + 1}`
      workbook.sheets[0].cells[ref] = { type: "number", value: row * 100 + column }
    }
  }
  const container = document.createElement("div")
  const t = translator()
  createWorkbookRenderer(t).mount(artifact(JSON.stringify(workbook)), container)

  expect(container.querySelectorAll("tbody tr")).toHaveLength(300)
  expect(container.querySelectorAll("col")).toHaveLength(61)
  const notice = container.querySelector(".copv-limited")
  expect(notice).toHaveTextContent("first 300 of 350 rows")
  expect(notice).toHaveTextContent("first 60 of")
})

it("renders a loading line until the number-format engine arrives", async () => {
  await jest.isolateModulesAsync(async () => {
    const fresh = await import("./preview")
    const container = document.createElement("div")
    const handle = fresh
      .createWorkbookRenderer({ t: translator(), onLocaleChange: () => () => {} })
      .mount(artifact(JSON.stringify(createWorkbook("Lazy"))), container)
    expect(container.querySelector('[role="status"]')).toHaveTextContent(
      "Loading workbook preview…"
    )
    await fresh.preloadWorkbookPreviewEngine()
    await Promise.resolve()
    expect(container.querySelector(".copv-tabs")).not.toBeNull()
    handle.dispose()
  })
})

it("keeps the grid scroll on update but resets it for a newly selected sheet", () => {
  const workbook = applyWorkbookOperations(createWorkbook("Scroll", "One"), [
    { op: "setCell", sheet: "One", cell: "A1", value: { type: "string", value: "a" } },
    { op: "addSheet", title: "Two" },
    { op: "setCell", sheet: "Two", cell: "A1", value: { type: "string", value: "b" } },
  ])
  const container = document.createElement("div")
  const handle = createWorkbookRenderer(translator()).mount(
    artifact(JSON.stringify(workbook)),
    container
  )
  container.querySelector<HTMLElement>(".copv-grid")!.scrollTop = 120
  handle.update?.(artifact(JSON.stringify(workbook)))
  expect(container.querySelector<HTMLElement>(".copv-grid")!.scrollTop).toBe(120)
  container.querySelectorAll<HTMLButtonElement>(".copv-tab")[1].click()
  expect(container.querySelector<HTMLElement>(".copv-grid")!.scrollTop).toBe(0)
})
