import ExcelJS from "exceljs"
import JSZip from "jszip"
import * as XLSX from "xlsx"
import { applyWorkbookOperations, createWorkbook } from "./model"
import { exportWorkbookXlsx, importDelimitedWorkbook, importWorkbookXlsx } from "./xlsx"

it("writes native XLSX styles, formulas, merges, filters, freezes, and dimensions", async () => {
  const source = applyWorkbookOperations(createWorkbook("Quote", "Quote"), [
    {
      op: "setCell",
      sheet: "Quote",
      cell: "A1",
      value: {
        type: "string",
        value: "Total",
        style: {
          font: { bold: true, color: "FFFFFF" },
          fill: { color: "2563EB" },
          alignment: { horizontal: "center" },
        },
      },
    },
    {
      op: "setCell",
      sheet: "Quote",
      cell: "B1",
      value: { type: "number", value: 12.5, formula: "10+2.5", style: { numberFormat: "$0.00" } },
    },
    { op: "merge", sheet: "Quote", range: "A2:B2" },
    { op: "setFilter", sheet: "Quote", range: "A1:B3" },
    { op: "setFreeze", sheet: "Quote", rows: 1, columns: 1 },
    { op: "setRowDimension", sheet: "Quote", row: 1, height: 24 },
    { op: "setColumnDimension", sheet: "Quote", column: "A", width: 20 },
  ])
  const bytes = await exportWorkbookXlsx(source)
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(Uint8Array.from(bytes).buffer)
  const sheet = workbook.getWorksheet("Quote")!
  expect(sheet.getCell("A1").font.bold).toBe(true)
  expect(sheet.getCell("A1").fill).toMatchObject({ fgColor: { argb: "FF2563EB" } })
  expect(sheet.getCell("B1").value).toMatchObject({ formula: "10+2.5", result: 12.5 })
  expect(sheet.getCell("B1").numFmt).toBe("$0.00")
  expect(sheet.views[0]).toMatchObject({ state: "frozen", xSplit: 1, ySplit: 1 })
  expect(sheet.autoFilter).toBe("A1:B3")
  expect(sheet.getRow(1).height).toBe(24)
  expect(sheet.getColumn("A").width).toBe(20)
  expect(sheet.getCell("A2").isMerged).toBe(true)
})

it("imports workbook values and warns about unsupported OOXML parts", async () => {
  const bytes = await exportWorkbookXlsx(createWorkbook("Backtest", "Results"))
  const zip = await JSZip.loadAsync(bytes)
  zip.file("xl/charts/chart1.xml", "<chart/>")
  const withChart = await zip.generateAsync({ type: "uint8array" })
  const imported = await importWorkbookXlsx(withChart, "Backtest", "backtest.xlsx")
  expect(imported.sheets[0].title).toBe("Results")
  expect(imported.sourceFilename).toBe("backtest.xlsx")
  expect(imported.unsupportedFeatures).toEqual(
    expect.arrayContaining([expect.stringContaining("charts")])
  )
})

it("round-trips typed cells, optional dimensions, styles, and all unsupported OOXML warnings", async () => {
  const source = applyWorkbookOperations(createWorkbook("Typed", "Data"), [
    { op: "setCell", sheet: "Data", cell: "A1", value: { type: "boolean", value: true } },
    {
      op: "setCell",
      sheet: "Data",
      cell: "A2",
      value: {
        type: "date",
        value: "2026-08-08T00:00:00.000Z",
        style: {
          font: { bold: true, italic: true, color: "#FF112233" },
          fill: { color: "ABCDEF" },
          alignment: { horizontal: "left", vertical: "middle", wrapText: true },
        },
      },
    },
    { op: "setCell", sheet: "Data", cell: "A3", value: { type: "error", value: "#N/A" } },
    { op: "setCell", sheet: "Data", cell: "A4", value: { type: "blank", formula: "1+1" } },
    {
      op: "setCell",
      sheet: "Data",
      cell: "A5",
      value: { type: "string", value: "italic", style: { font: { italic: true } } },
    },
    {
      op: "setCell",
      sheet: "Data",
      cell: "A6",
      value: { type: "string", value: "color", style: { font: { color: "112233" } } },
    },
    {
      op: "setCell",
      sheet: "Data",
      cell: "A7",
      value: {
        type: "string",
        value: "wrapped",
        style: { alignment: { wrapText: true } },
      },
    },
    {
      op: "setCell",
      sheet: "Data",
      cell: "A8",
      value: {
        type: "string",
        value: "right",
        style: { alignment: { horizontal: "right" } },
      },
    },
    { op: "setRowDimension", sheet: "Data", row: 2, hidden: true },
    { op: "setColumnDimension", sheet: "Data", column: "A", hidden: true },
    { op: "setColumnDimension", sheet: "Data", column: "C", width: 14 },
    { op: "setFreeze", sheet: "Data", rows: 1, columns: 1 },
  ])
  const bytes = await exportWorkbookXlsx(source)
  const styledImported = await importWorkbookXlsx(bytes, "Typed")
  expect(styledImported.sheets[0].cells.A2.style).toMatchObject({
    font: { bold: true, italic: true, color: "FF112233" },
    fill: { color: "FFABCDEF" },
    alignment: { horizontal: "left", vertical: "middle", wrapText: true },
  })
  expect(styledImported.sheets[0].freeze).toEqual({ rows: 1, columns: 1 })
  expect(styledImported.sheets[0].cells).toMatchObject({
    A5: { style: { font: { italic: true } } },
    A6: { style: { font: { color: "FF112233" } } },
    A7: { style: { alignment: { wrapText: true } } },
    A8: { style: { alignment: { horizontal: "right" } } },
  })

  const zip = await JSZip.loadAsync(bytes)
  zip.file("xl/pivotTables/pivotTable1.xml", "<pivotTable/>")
  zip.file("xl/externalLinks/externalLink1.xml", "<externalLink/>")
  const augmented = await zip.generateAsync({ type: "uint8array" })
  const imported = await importWorkbookXlsx(augmented, "", "typed.xlsx")

  expect(imported.title).toBe("typed")
  expect(imported.sheets[0].cells).toMatchObject({
    A1: { type: "boolean", value: true },
    A2: { type: "date" },
    A3: { type: "error" },
  })
  expect(imported.sheets[0].columnDimensions).toMatchObject({ C: { width: expect.any(Number) } })
  expect(imported.unsupportedFeatures).toEqual(
    expect.arrayContaining([
      expect.stringContaining("Pivot tables"),
      expect.stringContaining("External workbook links"),
    ])
  )

  const loaded = new ExcelJS.Workbook()
  await loaded.xlsx.load(Uint8Array.from(bytes).buffer)
  expect(loaded.getWorksheet("Data")?.getRow(2).hidden).toBe(true)
  expect(loaded.getWorksheet("Data")?.getColumn("A").hidden).toBe(true)
  expect(loaded.getWorksheet("Data")?.getCell("A4").value).toMatchObject({ formula: "1+1" })
})

it("imports delimited data and fails closed when a non-OOXML package cannot be inspected", async () => {
  const delimited = importDelimitedWorkbook("Name,Enabled\nA,true", "")
  expect(delimited).toMatchObject({
    title: "Workbook",
    sheets: [{ cells: { A1: { value: "Name" }, B2: { value: "true" } } }],
  })

  const csvBytes = new TextEncoder().encode("Name,Value\nA,1")
  const imported = await importWorkbookXlsx(csvBytes, "")
  expect(imported.title).toBe("Workbook")
  expect(imported.unsupportedFeatures).toContain(
    "The workbook package could not be inspected for unsupported OOXML features."
  )
})

it("imports sparse SheetJS dimensions and detects embedded macros", async () => {
  const sparseSheet = XLSX.utils.aoa_to_sheet([["value"]])
  const rows: XLSX.RowInfo[] = []
  const columns: XLSX.ColInfo[] = []
  rows[1] = { hpt: 10 }
  columns[1] = { wch: 12 }
  sparseSheet["!rows"] = rows
  sparseSheet["!cols"] = columns
  const sparseBook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(sparseBook, sparseSheet, "Sparse")
  sparseBook.vbaraw = new Uint8Array([1, 2, 3])
  const bytes = XLSX.write(sparseBook, {
    type: "array",
    bookType: "xlsm",
    bookVBA: true,
    cellStyles: true,
  }) as ArrayBuffer

  const imported = await importWorkbookXlsx(new Uint8Array(bytes), "Macros")
  expect(imported.sheets[0].rowDimensions).toMatchObject({ 2: { height: 10 } })
  expect(imported.sheets[0].columnDimensions).toMatchObject({ B: { width: 12 } })
  expect(imported.unsupportedFeatures).toContain(
    "Macros are present and will not be preserved when this workbook is exported."
  )
})
