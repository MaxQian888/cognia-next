import * as formulajs from "@formulajs/formulajs"
import {
  recalculateWorkbook,
  stronglyConnected,
  type FormulaFunctions,
  type RecalculateOptions,
} from "./formula-eval"
import { createWorkbook, type WorkbookCell, type WorkbookDocument } from "./model"
import { dateToSerial } from "./serial-date"

const functions = formulajs as unknown as FormulaFunctions

const n = (value: number): WorkbookCell => ({ type: "number", value })
const s = (value: string): WorkbookCell => ({ type: "string", value })
const f = (formula: string, cached?: WorkbookCell["value"]): WorkbookCell => ({
  type: "number",
  formula,
  ...(cached !== undefined ? { value: cached } : {}),
})

function book(cells: Record<string, WorkbookCell>, extra?: Record<string, WorkbookCell>) {
  const workbook = createWorkbook("Book")
  workbook.sheets[0].cells = cells
  if (extra) workbook.sheets.push({ id: "sheet-2", title: "Data 2", cells: extra, merges: [] })
  return workbook
}

function recalc(workbook: WorkbookDocument, options?: RecalculateOptions) {
  return recalculateWorkbook(workbook, functions, options)
}

const cell = (workbook: WorkbookDocument, ref: string, sheet = 0) =>
  workbook.sheets[sheet].cells[ref]

describe("recalculateWorkbook", () => {
  it("replaces an asserted cached value with the computed one", () => {
    const workbook = book({ A1: n(2), A2: n(3), A3: f("A1*A2", 999) })
    const report = recalc(workbook)
    expect(cell(workbook, "A3")).toEqual({ type: "number", formula: "A1*A2", value: 6 })
    expect(report).toMatchObject({ status: "complete", formulaCells: 1, evaluated: 1 })
  })

  it("evaluates in dependency order regardless of cell order", () => {
    const workbook = book({ A1: f("A2+1"), A2: f("A3*2"), A3: n(5) })
    recalc(workbook)
    expect(cell(workbook, "A2").value).toBe(10)
    expect(cell(workbook, "A1").value).toBe(11)
  })

  it("delegates functions to formulajs, ranges and dotted names included", () => {
    const workbook = book({
      A1: n(1),
      A2: n(2),
      A3: n(4),
      B1: f("SUM(A1:A3)"),
      B2: f("AVERAGE(A:A)"),
      B3: f("_xlfn.STDEV.S(A1:A3)"),
      B4: f('VLOOKUP("y",D1:E2,2,FALSE)'),
      D1: s("x"),
      D2: s("y"),
      E1: n(10),
      E2: n(20),
    })
    recalc(workbook)
    expect(cell(workbook, "B1").value).toBe(7)
    expect(cell(workbook, "B2").value).toBeCloseTo(7 / 3, 10)
    expect(cell(workbook, "B3").value).toBeCloseTo(1.527525231651947, 12)
    expect(cell(workbook, "B4").value).toBe(20)
  })

  it("reads other sheets by quoted name and reports a missing sheet as #REF!", () => {
    const workbook = book({ A1: f("'Data 2'!B2*2"), A2: f("Nope!A1") }, { B2: n(21) })
    recalc(workbook)
    expect(cell(workbook, "A1").value).toBe(42)
    expect(cell(workbook, "A2")).toMatchObject({ type: "error", value: "#REF!" })
  })

  it("applies Excel coercion, precision and error rules", () => {
    const workbook = book({
      A1: s("3"),
      A2: { type: "boolean", value: true },
      B1: f("A1+A2"),
      B2: f("0.1+0.2"),
      B3: f("1/0"),
      B4: f('"x"+1'),
      B5: f("B3+1"),
      B6: f('A1&"-"&A2&"-"&Z9'),
      B7: f('"abc"="ABC"'),
      B8: f('1<"a"'),
      B9: f("Z9"),
      B10: f("0^0"),
    })
    const report = recalc(workbook)
    expect(cell(workbook, "B1").value).toBe(4)
    expect(cell(workbook, "B2").value).toBe(0.3)
    expect(cell(workbook, "B3")).toMatchObject({ type: "error", value: "#DIV/0!" })
    expect(cell(workbook, "B4")).toMatchObject({ type: "error", value: "#VALUE!" })
    expect(cell(workbook, "B5")).toMatchObject({ type: "error", value: "#DIV/0!" })
    expect(cell(workbook, "B6")).toMatchObject({ type: "string", value: "3-TRUE-" })
    expect(cell(workbook, "B7")).toMatchObject({ type: "boolean", value: true })
    expect(cell(workbook, "B8").value).toBe(true)
    expect(cell(workbook, "B9")).toMatchObject({ type: "number", value: 0 })
    expect(cell(workbook, "B10")).toMatchObject({ type: "error", value: "#NUM!" })
    expect(report.errorCount).toBe(4)
    expect(report.errorCells.map((entry) => entry.cell)).toEqual(["B3", "B4", "B5", "B10"])
  })

  it("keeps IF and IFERROR lazy and supports array arithmetic", () => {
    const workbook = book({
      A1: n(1),
      A2: n(2),
      A3: n(3),
      B1: f("IF(A1>0,10,1/0)"),
      B2: f("IFERROR(1/0,-1)"),
      B3: f("IFNA(1/0,-1)"),
      B4: f("SUMPRODUCT((A1:A3>1)*A1:A3)"),
      B5: f("IF(A1>5,1)"),
      B6: f("SUM({1,2;3,4})"),
    })
    recalc(workbook)
    expect(cell(workbook, "B1").value).toBe(10)
    expect(cell(workbook, "B2").value).toBe(-1)
    expect(cell(workbook, "B3")).toMatchObject({ type: "error", value: "#DIV/0!" })
    expect(cell(workbook, "B4").value).toBe(5)
    expect(cell(workbook, "B5")).toMatchObject({ type: "boolean", value: false })
    expect(cell(workbook, "B6").value).toBe(10)
  })

  it("answers ROW/COLUMN/ROWS/COLUMNS from the reference", () => {
    const workbook = book({
      C5: f("ROW()*100+COLUMN()"),
      A1: f("ROWS(A:A)"),
      A2: f("COLUMNS(B2:E9)"),
      A3: f("SUM(ROW(A1:A4))"),
    })
    recalc(workbook)
    expect(cell(workbook, "C5").value).toBe(503)
    expect(cell(workbook, "A1").value).toBe(1_048_576)
    expect(cell(workbook, "A2").value).toBe(4)
    expect(cell(workbook, "A3").value).toBe(10)
  })

  it("turns a cycle into #REF! for its members and reports it", () => {
    const workbook = book({ A1: f("B1+1", 5), B1: f("A1+1"), C1: f("C1"), D1: f("A1*2") })
    const report = recalc(workbook)
    for (const ref of ["A1", "B1", "C1", "D1"])
      expect(cell(workbook, ref)).toMatchObject({ type: "error", value: "#REF!" })
    expect(report.issues.map((issue) => [issue.cell, issue.kind]).sort()).toEqual([
      ["A1", "circular"],
      ["B1", "circular"],
      ["C1", "circular"],
    ])
  })

  it("keeps the cached value of what it cannot evaluate, else writes an error", () => {
    const workbook = book({
      A1: f("TaxRate*2", 40),
      A2: f("TaxRate*2"),
      A3: f("Table1[Amount]"),
      A4: f("NOSUCHFN(1)"),
      A5: f("SUM(1", 7),
      A6: f("A1+1"),
      A7: f("A1:A2+1"),
    })
    const report = recalc(workbook)
    expect(cell(workbook, "A1")).toEqual(f("TaxRate*2", 40))
    expect(cell(workbook, "A2")).toMatchObject({ type: "error", value: "#NAME?" })
    expect(cell(workbook, "A3")).toMatchObject({ type: "error", value: "#VALUE!" })
    expect(cell(workbook, "A4")).toMatchObject({ type: "error", value: "#NAME?" })
    expect(cell(workbook, "A5").value).toBe(7)
    expect(cell(workbook, "A6").value).toBe(41)
    expect(cell(workbook, "A7")).toMatchObject({ type: "error", value: "#VALUE!" })
    expect(report.issues.map((issue) => [issue.cell, issue.kind])).toEqual([
      ["A1", "unsupported"],
      ["A2", "unsupported"],
      ["A3", "unsupported"],
      ["A4", "unsupported"],
      ["A5", "syntax"],
      ["A7", "unsupported"],
    ])
    expect(report.evaluated).toBe(1)
  })

  it("stores date results as dates and computes with date cells", () => {
    const workbook = book({
      A1: { type: "date", value: new Date(2024, 0, 15).toISOString() },
      B1: f("A1+30"),
      B2: { type: "date", formula: "A1+1" },
      B3: f("DATE(2024,2,29)"),
      B4: f("YEAR(A1)"),
    })
    recalc(workbook)
    expect(cell(workbook, "B1")).toMatchObject({ type: "number", value: 45336 })
    expect(cell(workbook, "B2")).toMatchObject({
      type: "date",
      value: new Date(2024, 0, 16).toISOString(),
    })
    expect(cell(workbook, "B3").type).toBe("date")
    expect(dateToSerial(new Date(String(cell(workbook, "B3").value)))).toBe(45351)
    expect(cell(workbook, "B4").value).toBe(2024)
  })

  it("keeps formatting and the formula text on write-back", () => {
    const workbook = book({
      A1: { type: "number", formula: "1+1", style: { numberFormat: "0.00" } },
    })
    recalc(workbook)
    expect(cell(workbook, "A1")).toEqual({
      type: "number",
      formula: "1+1",
      value: 2,
      style: { numberFormat: "0.00" },
    })
  })

  it("evaluates a long running-total chain without deep recursion", () => {
    const cells: Record<string, WorkbookCell> = { A1: n(1) }
    for (let row = 2; row <= 20_000; row += 1) cells[`A${row}`] = f(`A${row - 1}+1`)
    const workbook = book(cells)
    expect(recalc(workbook).status).toBe("complete")
    expect(cell(workbook, "A20000").value).toBe(20_000)
  })

  it("skips without writing anything when a budget is exceeded", () => {
    const original = () => book({ A1: n(1), A2: f("SUM(A1:A1)", 9), A3: f("A2+1", 9) })
    const limits: Array<[RecalculateOptions, string]> = [
      [{ maxFormulaCells: 1 }, "formula-limit"],
      [{ maxDependencies: 0 }, "dependency-limit"],
      [{ maxCellReads: 1 }, "read-limit"],
    ]
    for (const [options, reason] of limits) {
      const workbook = original()
      expect(recalc(workbook, options)).toMatchObject({ status: "skipped", reason, evaluated: 0 })
      expect(workbook).toEqual(original())
    }
    let clock = 0
    const workbook = original()
    const report = recalc(workbook, { now: () => (clock += 10), timeBudgetMs: 15 })
    expect(report).toMatchObject({ status: "skipped", reason: "time-limit" })
    expect(workbook).toEqual(original())
  })

  it("caps the reported lists but keeps exact counts", () => {
    const cells: Record<string, WorkbookCell> = {}
    for (let row = 1; row <= 30; row += 1) cells[`A${row}`] = f("1/0")
    const report = recalc(book(cells))
    expect(report.errorCount).toBe(30)
    expect(report.errorCells).toHaveLength(20)
  })

  it("is a no-op report for a workbook without formulas", () => {
    expect(recalc(book({ A1: n(1) }))).toMatchObject({ status: "complete", formulaCells: 0 })
  })
})

describe("stronglyConnected", () => {
  it("emits dependencies before their dependents and groups cycles", () => {
    // 0 → 1 → 2 → 1, 3 → 0
    const components = stronglyConnected(4, [[1], [2], [1], [0]])
    expect(components).toEqual([[2, 1], [0], [3]])
  })
})
