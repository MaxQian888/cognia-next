import { applyWorkbookOperations, createWorkbook } from "./model"
import { cellValue, formatWorkbookRead, MAX_READ_CELLS, readWorkbook } from "./read-range"

function sample() {
  return applyWorkbookOperations(createWorkbook("Read", "Data"), [
    {
      op: "setRange",
      sheet: "Data",
      range: "A1:C3",
      values: [
        [
          { type: "string", value: "Item" },
          { type: "string", value: "Qty" },
          { type: "string", value: "Total" },
        ],
        [
          { type: "string", value: "Pen" },
          { type: "number", value: 3 },
          { type: "number", value: 6, formula: "B2*2" },
        ],
        [
          { type: "string", value: "Ink" },
          { type: "blank" },
          { type: "error", value: "#DIV/0!", formula: "1/0" },
        ],
      ],
    },
    { op: "addSheet", title: "Notes" },
  ])
}

it("reads every sheet's used range with values and a formula map", () => {
  const read = readWorkbook(sample())
  expect(read.truncated).toBe(false)
  expect(read.cellsReturned).toBe(9)
  expect(read.sheets[0]).toEqual({
    id: "sheet-1",
    title: "Data",
    usedRange: "A1:C3",
    range: "A1:C3",
    rows: [
      ["Item", "Qty", "Total"],
      ["Pen", 3, 6],
      ["Ink", null, "#DIV/0!"],
    ],
    formulas: { C2: "=B2*2", C3: "=1/0" },
    truncated: false,
  })
  expect(read.sheets[1]).toEqual({ id: "sheet-2", title: "Notes", rows: [], truncated: false })
})

it("reads a requested block by sheet title or id, optionally without formulas", () => {
  const read = readWorkbook(sample(), {
    sheet: "sheet-1",
    range: "b2:c3",
    includeFormulas: false,
  })
  expect(read.sheets).toHaveLength(1)
  expect(read.sheets[0]).toMatchObject({
    range: "B2:C3",
    rows: [
      [3, 6],
      [null, "#DIV/0!"],
    ],
  })
  expect(read.sheets[0].formulas).toBeUndefined()
})

it("keeps whole rows and flags truncation when the budget runs out", () => {
  const read = readWorkbook(sample(), { maxCells: 7 })
  expect(read.sheets[0]).toMatchObject({ range: "A1:C2", truncated: true })
  expect(read.sheets[0].rows).toHaveLength(2)
  expect(read.truncated).toBe(true)
  expect(read.cellsReturned).toBe(6)
  // A single row wider than the budget is clipped by column instead.
  const narrow = readWorkbook(sample(), { maxCells: 2 })
  expect(narrow.sheets[0]).toMatchObject({ range: "A1:B1", rows: [["Item", "Qty"]] })
})

it("marks later sheets truncated once the shared budget is spent", () => {
  const workbook = applyWorkbookOperations(sample(), [
    { op: "setCell", sheet: "Notes", cell: "A1", value: { type: "string", value: "n" } },
  ])
  const read = readWorkbook(workbook, { maxCells: 9 })
  expect(read.sheets[1]).toMatchObject({ rows: [], truncated: true, usedRange: "A1" })
})

it.each([
  [{ maxCells: 0 }, "maxCells must be"],
  [{ maxCells: MAX_READ_CELLS + 1 }, "maxCells must be"],
  [{ range: "A1:B2" }, "range needs a sheet"],
  [{ sheet: "Missing" }, "sheet not found"],
  [{ sheet: "Data", range: "B2:A1" }, "invalid range"],
  [{ sheet: "Data", range: "not a range" }, "invalid range"],
  [{ sheet: "Data", range: "A1:A1048577" }, "invalid range"],
  [{ sheet: "Data", range: "A1:XFE1" }, "invalid range"],
])("rejects %j", (options, message) => {
  expect(() => readWorkbook(sample(), options)).toThrow(message)
})

it("renders a read as tab-separated text per sheet", () => {
  expect(formatWorkbookRead(readWorkbook(sample(), { maxCells: 7 }))).toBe(
    [
      "## Data (A1:C2)",
      "Item\tQty\tTotal",
      "Pen\t3\t6",
      "",
      "Formulas:",
      "C2: =B2*2",
      "(truncated)",
      "",
      "## Notes",
      "(empty)",
    ].join("\n")
  )
})

it("maps cell types to JSON values", () => {
  expect(cellValue(undefined)).toBeNull()
  expect(cellValue({ type: "blank", value: "x" })).toBeNull()
  expect(cellValue({ type: "boolean", value: true })).toBe(true)
  expect(cellValue({ type: "date", value: "2026-01-02T00:00:00.000Z" })).toBe(
    "2026-01-02T00:00:00.000Z"
  )
})
