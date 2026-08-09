import { applyWorkbookOperations, createWorkbook, validateWorkbook } from "./model"
import { exportWorkbookXlsx, importWorkbookXlsx } from "./xlsx"

const header = (value: string) => ({
  type: "string" as const,
  value,
  style: { font: { bold: true }, fill: { color: "D9EAF7" } },
})

const fixtures = [
  {
    name: "inventory split across sheets",
    build: () =>
      applyWorkbookOperations(createWorkbook("Inventory", "Warehouse A"), [
        {
          op: "setRange",
          sheet: "Warehouse A",
          range: "A1:C2",
          values: [
            [header("SKU"), header("Quantity"), header("Value")],
            [
              { type: "string", value: "A-100" },
              { type: "number", value: 12 },
              { type: "number", value: 120, formula: "B2*10" },
            ],
          ],
        },
        { op: "setFilter", sheet: "Warehouse A", range: "A1:C2" },
        { op: "setFreeze", sheet: "Warehouse A", rows: 1 },
        { op: "addSheet", title: "Warehouse B" },
        { op: "setCell", sheet: "Warehouse B", cell: "A1", value: header("SKU") },
      ]),
  },
  {
    name: "quote workbook with summary",
    build: () =>
      applyWorkbookOperations(createWorkbook("Customer Quote", "Line Items"), [
        {
          op: "setRange",
          sheet: "Line Items",
          range: "A1:D2",
          values: [
            [header("Item"), header("Qty"), header("Unit Price"), header("Amount")],
            [
              { type: "string", value: "Consulting" },
              { type: "number", value: 5 },
              { type: "number", value: 200, style: { numberFormat: "$#,##0.00" } },
              {
                type: "number",
                value: 1000,
                formula: "B2*C2",
                style: { numberFormat: "$#,##0.00" },
              },
            ],
          ],
        },
        { op: "addSheet", title: "Summary" },
        {
          op: "setCell",
          sheet: "Summary",
          cell: "B2",
          value: { type: "number", value: 1000, formula: "SUM('Line Items'!D2:D2)" },
        },
      ]),
  },
  {
    name: "portfolio valuation and limit checks",
    build: () =>
      applyWorkbookOperations(createWorkbook("Portfolio", "Holdings"), [
        {
          op: "setRange",
          sheet: "Holdings",
          range: "A1:D2",
          values: [
            [header("Ticker"), header("Units"), header("Price"), header("Market Value")],
            [
              { type: "string", value: "ACME" },
              { type: "number", value: 10 },
              { type: "number", value: 25 },
              { type: "number", value: 250, formula: "B2*C2" },
            ],
          ],
        },
        { op: "addSheet", title: "Limits" },
        {
          op: "setCell",
          sheet: "Limits",
          cell: "B2",
          value: { type: "boolean", value: true, formula: "Holdings!D2<=500" },
        },
      ]),
  },
  {
    name: "trading P&L reconciliation",
    build: () =>
      applyWorkbookOperations(createWorkbook("Trading P&L", "Trades"), [
        {
          op: "setRange",
          sheet: "Trades",
          range: "A1:C2",
          values: [
            [header("Trade"), header("Desk P&L"), header("Ledger P&L")],
            [
              { type: "string", value: "T-1" },
              { type: "number", value: 42 },
              { type: "number", value: 40 },
            ],
          ],
        },
        { op: "addSheet", title: "Reconciliation" },
        {
          op: "setCell",
          sheet: "Reconciliation",
          cell: "A1",
          value: { type: "number", value: 2, formula: "Trades!B2-Trades!C2" },
        },
      ]),
  },
  {
    name: "crypto backtest workbook",
    build: () =>
      applyWorkbookOperations(createWorkbook("Crypto Backtest", "Results"), [
        {
          op: "setRange",
          sheet: "Results",
          range: "A1:C2",
          values: [
            [header("Date"), header("Return"), header("Equity")],
            [
              { type: "date", value: "2026-01-01T00:00:00.000Z" },
              { type: "number", value: 0.05, style: { numberFormat: "0.00%" } },
              { type: "number", value: 105, formula: "100*(1+B2)" },
            ],
          ],
        },
        { op: "setColumnDimension", sheet: "Results", column: "A", width: 14 },
        { op: "addSheet", title: "Metrics" },
        {
          op: "setCell",
          sheet: "Metrics",
          cell: "B2",
          value: { type: "number", value: 0.05, formula: "MAX(Results!B2:B2)" },
        },
      ]),
  },
] as const

it.each(fixtures)("round-trips WorkBuddy Bench fixture: $name", async ({ build, name }) => {
  const workbook = build()
  expect(validateWorkbook(workbook)).toEqual([])

  const bytes = await exportWorkbookXlsx(workbook)
  const imported = await importWorkbookXlsx(bytes, workbook.title, `${name}.xlsx`)

  expect(imported.sheets.map((sheet) => sheet.title)).toEqual(
    workbook.sheets.map((sheet) => sheet.title)
  )
  expect(
    imported.sheets.some((sheet) => Object.values(sheet.cells).some((cell) => cell.formula))
  ).toBe(true)
  expect(validateWorkbook(imported).filter((finding) => finding.severity === "error")).toEqual([])
})
