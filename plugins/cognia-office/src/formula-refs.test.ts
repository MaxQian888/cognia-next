import {
  formatSheetPrefix,
  REF_ERROR,
  rewriteFormula,
  rewriteWorkbookFormulas,
  type FormulaEdit,
} from "./formula-refs"

const insertRows = (sheet: string, row: number, count = 1): FormulaEdit => ({
  kind: "axis",
  sheet,
  axis: "r",
  at: row - 1,
  count,
  mode: "insert",
})
const deleteRows = (sheet: string, row: number, count = 1): FormulaEdit => ({
  kind: "axis",
  sheet,
  axis: "r",
  at: row - 1,
  count,
  mode: "delete",
})
const insertColumns = (sheet: string, column: number, count = 1): FormulaEdit => ({
  kind: "axis",
  sheet,
  axis: "c",
  at: column,
  count,
  mode: "insert",
})
const deleteColumns = (sheet: string, column: number, count = 1): FormulaEdit => ({
  kind: "axis",
  sheet,
  axis: "c",
  at: column,
  count,
  mode: "delete",
})

describe("rewriteFormula — row and column edits", () => {
  it("shifts references at or after an inserted row and grows spanning ranges", () => {
    const edit = insertRows("Data", 3, 2)
    expect(rewriteFormula("B2*10", "Data", edit)).toBe("B2*10")
    expect(rewriteFormula("B3*10", "Data", edit)).toBe("B5*10")
    expect(rewriteFormula("SUM(A1:A5)", "Data", edit)).toBe("SUM(A1:A7)")
    expect(rewriteFormula("SUM(A3:A5)", "Data", edit)).toBe("SUM(A5:A7)")
    expect(rewriteFormula("$B$4+B$4+$B4", "Data", edit)).toBe("$B$6+B$6+$B6")
  })

  it("shifts inserted columns and leaves row-only spans alone", () => {
    const edit = insertColumns("Data", 1, 2) // before column B
    expect(rewriteFormula("A1+B1+C1", "Data", edit)).toBe("A1+D1+E1")
    expect(rewriteFormula("SUM(A:C)", "Data", edit)).toBe("SUM(A:E)")
    expect(rewriteFormula("SUM(2:3)", "Data", edit)).toBe("SUM(2:3)")
    expect(rewriteFormula("SUM($B:$B)", "Data", edit)).toBe("SUM($D:$D)")
  })

  it("turns deleted references into #REF! and shrinks partially deleted ranges", () => {
    const edit = deleteRows("Data", 2, 2) // rows 2-3
    expect(rewriteFormula("A1+A2", "Data", edit)).toBe(`A1+${REF_ERROR}`)
    expect(rewriteFormula("A4*2", "Data", edit)).toBe("A2*2")
    expect(rewriteFormula("SUM(A1:A5)", "Data", edit)).toBe("SUM(A1:A3)")
    expect(rewriteFormula("SUM(A2:A3)", "Data", edit)).toBe(`SUM(${REF_ERROR})`)
    expect(rewriteFormula("SUM(A3:A6)", "Data", edit)).toBe("SUM(A2:A4)")
    expect(rewriteFormula("SUM(2:4)", "Data", edit)).toBe("SUM(2:2)")
    expect(rewriteFormula("SUM(B:B)", "Data", edit)).toBe("SUM(B:B)")
  })

  it("clamps a range whose end falls in the deleted span onto its surviving start", () => {
    expect(rewriteFormula("SUM(A1:A2)", "Data", deleteRows("Data", 2, 2))).toBe("SUM(A1:A1)")
  })

  it("deletes columns the same way", () => {
    const edit = deleteColumns("Data", 1) // column B
    expect(rewriteFormula("A1+B1+C1", "Data", edit)).toBe(`A1+${REF_ERROR}+B1`)
    expect(rewriteFormula("SUM(A1:C1)", "Data", edit)).toBe("SUM(A1:B1)")
    expect(rewriteFormula("SUM(B:B)", "Data", edit)).toBe(`SUM(${REF_ERROR})`)
  })

  it("only rewrites references that point at the edited sheet", () => {
    const edit = insertRows("Data", 1)
    // Implicit references belong to the formula's own sheet.
    expect(rewriteFormula("A1", "Summary", edit)).toBe("A1")
    expect(rewriteFormula("Data!A1+A1", "Summary", edit)).toBe("Data!A2+A1")
    expect(rewriteFormula("data!A1", "Summary", edit)).toBe("data!A2")
    expect(rewriteFormula("'Data'!A1:B2", "Summary", edit)).toBe("'Data'!A2:B3")
    expect(rewriteFormula("Other!A1", "Data", edit)).toBe("Other!A1")
  })

  it("keeps a range anchored to the last row and refuses to push a start off the sheet", () => {
    const edit = insertRows("Data", 5)
    expect(rewriteFormula("SUM(A2:A1048576)", "Data", edit)).toBe("SUM(A2:A1048576)")
    expect(rewriteFormula("A1048576", "Data", edit)).toBe(REF_ERROR)
  })

  it("keeps a reversed range in its written orientation", () => {
    expect(rewriteFormula("SUM(A5:A2)", "Data", insertRows("Data", 3))).toBe("SUM(A6:A2)")
  })
})

describe("rewriteFormula — tokens that are not references", () => {
  const edit = insertRows("Data", 1)

  it("leaves strings, function names, and numbers alone", () => {
    expect(rewriteFormula('IF(A1>0,"A1","B2:C3")', "Data", edit)).toBe('IF(A2>0,"A1","B2:C3")')
    expect(rewriteFormula('"say ""A1"""&A1', "Data", edit)).toBe('"say ""A1"""&A2')
    expect(rewriteFormula("LOG10(A1)+ATAN2(A1,B1)", "Data", edit)).toBe("LOG10(A2)+ATAN2(A2,B2)")
    expect(rewriteFormula("1E5+A1*1.5", "Data", edit)).toBe("1E5+A2*1.5")
    expect(rewriteFormula("TRUE+A1B", "Data", edit)).toBe("TRUE+A1B")
  })

  it("leaves structured and external references alone", () => {
    expect(rewriteFormula("SUM(Tbl1[Amount])+A1", "Data", edit)).toBe("SUM(Tbl1[Amount])+A2")
    expect(rewriteFormula("[1]Data!A1+Data!A1", "Summary", edit)).toBe("[1]Data!A1+Data!A2")
    expect(rewriteFormula("'[Book.xlsx]Data'!A1", "Summary", edit)).toBe("'[Book.xlsx]Data'!A1")
    expect(rewriteFormula("[1]'Data'!A1+'Data'!A1", "Summary", edit)).toBe("[1]'Data'!A1+'Data'!A2")
  })

  it("accepts lowercase references and rewrites them in canonical form", () => {
    expect(rewriteFormula("sum(a1:b2)", "Data", edit)).toBe("sum(A2:B3)")
  })

  it("does not shift 3D references for a single-sheet edit", () => {
    expect(rewriteFormula("SUM(Jan:Mar!A1)", "Summary", insertRows("Jan", 1))).toBe(
      "SUM(Jan:Mar!A1)"
    )
  })
})

describe("rewriteFormula — sheet renames and deletions", () => {
  it("renames sheet prefixes and re-quotes when the new name needs it", () => {
    const edit: FormulaEdit = { kind: "renameSheet", from: "Data", to: "Raw data" }
    expect(rewriteFormula("Data!A1+data!B2", "Summary", edit)).toBe("'Raw data'!A1+'Raw data'!B2")
    expect(rewriteFormula("A1", "Data", edit)).toBe("A1")
    expect(
      rewriteFormula("'Raw data'!A1", "Summary", {
        kind: "renameSheet",
        from: "Raw data",
        to: "Clean",
      })
    ).toBe("Clean!A1")
  })

  it("renames either endpoint of a 3D span", () => {
    expect(
      rewriteFormula("SUM(Jan:Mar!A1)", "Summary", {
        kind: "renameSheet",
        from: "Mar",
        to: "Q1 end",
      })
    ).toBe("SUM('Jan:Q1 end'!A1)")
  })

  it("reads a quoted 3D span it wrote and follows a later rename or deletion", () => {
    expect(
      rewriteFormula("SUM('Jan:Q1 end'!A1)", "Summary", {
        kind: "renameSheet",
        from: "Jan",
        to: "Start",
      })
    ).toBe("SUM('Start:Q1 end'!A1)")
    expect(
      rewriteFormula("SUM('Jan:Q1 end'!A1)", "Summary", { kind: "deleteSheet", sheet: "Q1 end" })
    ).toBe(`SUM(${REF_ERROR})`)
  })

  it("turns references into a deleted sheet into #REF!", () => {
    const edit: FormulaEdit = { kind: "deleteSheet", sheet: "Data" }
    expect(rewriteFormula("Data!A1+Other!A1+A1", "Summary", edit)).toBe(`${REF_ERROR}+Other!A1+A1`)
    expect(rewriteFormula("SUM(Data:Other!A1)", "Summary", edit)).toBe(`SUM(${REF_ERROR})`)
  })
})

describe("formatSheetPrefix", () => {
  it("quotes names Excel cannot read bare", () => {
    expect(formatSheetPrefix("Data")).toBe("Data!")
    expect(formatSheetPrefix("销售")).toBe("销售!")
    expect(formatSheetPrefix("Q1 data")).toBe("'Q1 data'!")
    expect(formatSheetPrefix("Bob's")).toBe("'Bob''s'!")
    expect(formatSheetPrefix("A1")).toBe("'A1'!")
    expect(formatSheetPrefix("R1C1")).toBe("'R1C1'!")
    expect(formatSheetPrefix("2024")).toBe("'2024'!")
    expect(formatSheetPrefix("TRUE")).toBe("'TRUE'!")
  })
})

it("rewrites every formula across a workbook in place", () => {
  const sheets: Array<{ title: string; cells: Record<string, { formula?: string }> }> = [
    { title: "Data", cells: { A1: { formula: "B1" }, B1: {} } },
    { title: "Summary", cells: { A1: { formula: "Data!A1+A1" } } },
  ]
  rewriteWorkbookFormulas(sheets, {
    kind: "axis",
    sheet: "Data",
    axis: "c",
    at: 0,
    count: 1,
    mode: "insert",
  })
  expect(sheets[0].cells.A1.formula).toBe("C1")
  expect(sheets[1].cells.A1.formula).toBe("Data!B1+A1")
})
