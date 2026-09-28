import {
  applyWorkbookOperations,
  createWorkbook,
  parseWorkbook,
  summarizeWorkbook,
  usedRange,
  validateWorkbook,
  WORKBOOK_OPERATION_NAMES,
  type WorkbookOperation,
} from "./model"

it("builds a multi-sheet business workbook with formulas and layout operations", () => {
  const workbook = applyWorkbookOperations(createWorkbook("Inventory", "Stock"), [
    {
      op: "setRange",
      sheet: "Stock",
      range: "A1:C2",
      values: [
        [
          { type: "string", value: "SKU", style: { font: { bold: true } } },
          { type: "string", value: "Qty" },
          { type: "string", value: "Value" },
        ],
        [
          { type: "string", value: "A-1" },
          { type: "number", value: 4 },
          { type: "number", value: 40, formula: "B2*10" },
        ],
      ],
    },
    { op: "setFilter", sheet: "Stock", range: "A1:C2" },
    { op: "setFreeze", sheet: "Stock", rows: 1 },
    { op: "setColumnDimension", sheet: "Stock", column: "A", width: 18 },
    { op: "addSheet", title: "Summary" },
    {
      op: "setCell",
      sheet: "Summary",
      cell: "A1",
      value: { type: "number", formula: "SUM(Stock!C2:C2)", value: 40 },
    },
  ])
  expect(workbook.sheets.map((sheet) => sheet.title)).toEqual(["Stock", "Summary"])
  expect(workbook.sheets[0]).toMatchObject({
    filter: "A1:C2",
    freeze: { rows: 1 },
    columnDimensions: { A: { width: 18 } },
  })
  expect(parseWorkbook(JSON.stringify(workbook))).toEqual(workbook)
  expect(validateWorkbook(workbook)).toEqual([])
})

it("rejects dimension mismatches and deleting the final sheet", () => {
  expect(() =>
    applyWorkbookOperations(createWorkbook("Quote"), [
      {
        op: "setRange",
        sheet: "Sheet1",
        range: "A1:B2",
        values: [[{ type: "string", value: "x" }]],
      },
    ])
  ).toThrow("dimensions")
  expect(() =>
    applyWorkbookOperations(createWorkbook("Quote"), [{ op: "deleteSheet", sheet: "Sheet1" }])
  ).toThrow("last sheet")
})

it("reports unsupported import features as validation warnings", () => {
  const workbook = createWorkbook("Portfolio")
  workbook.unsupportedFeatures.push("Pivot tables cannot be preserved.")
  expect(validateWorkbook(workbook)).toContainEqual(
    expect.objectContaining({
      severity: "warning",
      code: "feature.unsupported",
      remediation: expect.stringContaining("confirming"),
    })
  )
})

it("supports every deterministic sheet and layout operation", () => {
  const workbook = applyWorkbookOperations(createWorkbook("Operations", "Alpha"), [
    { op: "addSheet", title: "Beta", index: 0 },
    { op: "renameSheet", sheet: "Alpha", title: "Gamma" },
    { op: "reorderSheet", sheet: "Gamma", index: 0 },
    {
      op: "setCell",
      sheet: "Gamma",
      cell: "A1",
      value: { type: "number", value: 2, formula: "=1+1" },
    },
    { op: "merge", sheet: "Gamma", range: "A1:B1" },
    { op: "merge", sheet: "Gamma", range: "A1:B1" },
    { op: "unmerge", sheet: "Gamma", range: "A1:B1" },
    { op: "setFilter", sheet: "Gamma", range: "A1:B2" },
    { op: "setFilter", sheet: "Gamma" },
    { op: "setFreeze", sheet: "Gamma" },
    { op: "setRowDimension", sheet: "Gamma", row: 2, height: 18, hidden: true },
    { op: "setColumnDimension", sheet: "Gamma", column: "b", width: 12, hidden: true },
    { op: "deleteSheet", sheet: "Beta" },
  ])

  expect(workbook.sheets).toHaveLength(1)
  expect(workbook.sheets[0]).toMatchObject({
    title: "Gamma",
    cells: { A1: { formula: "1+1" } },
    merges: [],
    rowDimensions: { 2: { height: 18, hidden: true } },
    columnDimensions: { B: { width: 12, hidden: true } },
  })
  expect(workbook.sheets[0].filter).toBeUndefined()
  // A freeze with no rows and no columns removes the frozen pane.
  expect(workbook.sheets[0].freeze).toBeUndefined()
})

it.each([
  ["blank workbook title", () => createWorkbook(" "), "title must be"],
  [
    "invalid add index",
    () => applyWorkbookOperations(createWorkbook("x"), [{ op: "addSheet", title: "B", index: -1 }]),
    "out of bounds",
  ],
  [
    "non-integer add index",
    () =>
      applyWorkbookOperations(createWorkbook("x"), [{ op: "addSheet", title: "B", index: 0.5 }]),
    "out of bounds",
  ],
  [
    "missing sheet",
    () => applyWorkbookOperations(createWorkbook("x"), [{ op: "deleteSheet", sheet: "missing" }]),
    "sheet not found",
  ],
  [
    "invalid reorder index",
    () =>
      applyWorkbookOperations(createWorkbook("x"), [
        { op: "addSheet", title: "B" },
        { op: "reorderSheet", sheet: "B", index: 2 },
      ]),
    "out of bounds",
  ],
  [
    "invalid cell",
    () =>
      applyWorkbookOperations(createWorkbook("x"), [
        { op: "setCell", sheet: "Sheet1", cell: "bad", value: { type: "string" } },
      ]),
    "invalid cell",
  ],
  [
    "invalid merge",
    () =>
      applyWorkbookOperations(createWorkbook("x"), [
        { op: "merge", sheet: "Sheet1", range: "B2:A1" },
      ]),
    "invalid merge",
  ],
  [
    "invalid filter",
    () =>
      applyWorkbookOperations(createWorkbook("x"), [
        { op: "setFilter", sheet: "Sheet1", range: "B2:A1" },
      ]),
    "invalid filter",
  ],
  [
    "invalid freeze",
    () =>
      applyWorkbookOperations(createWorkbook("x"), [
        { op: "setFreeze", sheet: "Sheet1", rows: -1 },
      ]),
    "freeze count",
  ],
  [
    "invalid row",
    () =>
      applyWorkbookOperations(createWorkbook("x"), [
        { op: "setRowDimension", sheet: "Sheet1", row: 0 },
      ]),
    "between 1 and",
  ],
  [
    "row beyond worksheet bounds",
    () =>
      applyWorkbookOperations(createWorkbook("x"), [
        { op: "setRowDimension", sheet: "Sheet1", row: 1048577 },
      ]),
    "between 1 and",
  ],
  [
    "cell row zero",
    () =>
      applyWorkbookOperations(createWorkbook("x"), [
        { op: "setCell", sheet: "Sheet1", cell: "A0", value: { type: "string" } },
      ]),
    "invalid cell",
  ],
  [
    "cell beyond XFD",
    () =>
      applyWorkbookOperations(createWorkbook("x"), [
        { op: "setCell", sheet: "Sheet1", cell: "XFE1", value: { type: "string" } },
      ]),
    "invalid cell",
  ],
  [
    "cell beyond max row",
    () =>
      applyWorkbookOperations(createWorkbook("x"), [
        { op: "setCell", sheet: "Sheet1", cell: "A1048577", value: { type: "string" } },
      ]),
    "invalid cell",
  ],
  [
    "degenerate range",
    () =>
      applyWorkbookOperations(createWorkbook("x"), [
        { op: "merge", sheet: "Sheet1", range: ":::" },
      ]),
    "invalid merge",
  ],
  [
    "range beyond worksheet bounds",
    () =>
      applyWorkbookOperations(createWorkbook("x"), [
        { op: "setFilter", sheet: "Sheet1", range: "A1:XFE2" },
      ]),
    "invalid filter",
  ],
  [
    "column dimension beyond XFD",
    () =>
      applyWorkbookOperations(createWorkbook("x"), [
        { op: "setColumnDimension", sheet: "Sheet1", column: "XFE" },
      ]),
    "invalid column",
  ],
  [
    "invalid row height",
    () =>
      applyWorkbookOperations(createWorkbook("x"), [
        { op: "setRowDimension", sheet: "Sheet1", row: 1, height: Number.NaN },
      ]),
    "dimension must be positive",
  ],
  [
    "invalid column",
    () =>
      applyWorkbookOperations(createWorkbook("x"), [
        { op: "setColumnDimension", sheet: "Sheet1", column: "123" },
      ]),
    "invalid column",
  ],
  [
    "invalid column width",
    () =>
      applyWorkbookOperations(createWorkbook("x"), [
        { op: "setColumnDimension", sheet: "Sheet1", column: "A", width: 0 },
      ]),
    "dimension must be positive",
  ],
] as const)("rejects %s", (_name, action, message) => {
  expect(action).toThrow(message)
})

it("reports all structural workbook validation errors", () => {
  expect(validateWorkbook({ ...createWorkbook("x"), title: "", sheets: [] })).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: "title.empty" }),
      expect.objectContaining({ code: "sheets.empty" }),
    ])
  )

  const workbook = createWorkbook("Validation", "Data")
  workbook.sheets.push({
    ...structuredClone(workbook.sheets[0]),
    title: "data",
  })
  Object.assign(workbook.sheets[0], {
    id: workbook.sheets[1].id,
    title: "Bad/Sheet",
    cells: {
      BAD: { type: "string" },
      A1: { type: "number", value: "not-a-number", formula: " " },
    },
    merges: ["B2:A1"],
    filter: "B2:A1",
  })
  workbook.sheets[1].title = "Bad/Sheet"
  const codes = validateWorkbook(workbook).map((finding) => finding.code)
  expect(codes).toEqual(
    expect.arrayContaining([
      "sheet.title.invalid",
      "sheet.title.duplicate",
      "sheet.id.duplicate",
      "cell.ref.invalid",
      "cell.formula.empty",
      "cell.type.invalid",
      "merge.invalid",
      "filter.invalid",
    ])
  )

  workbook.sheets[0].title = ""
  expect(validateWorkbook(workbook)).toContainEqual(
    expect.objectContaining({ code: "sheet.title.empty" })
  )
})

it("rejects incompatible or invalid serialized workbook documents", () => {
  expect(() => parseWorkbook(JSON.stringify({ ...createWorkbook("x"), schemaVersion: 2 }))).toThrow(
    "unsupported workbook schema version"
  )
  expect(() => parseWorkbook(JSON.stringify({ ...createWorkbook("x"), title: "" }))).toThrow(
    "title.empty"
  )
})

it("allocates an unused sheet id when imported ids are sparse", () => {
  const workbook = createWorkbook("IDs")
  workbook.sheets[0].id = "sheet-2"
  const updated = applyWorkbookOperations(workbook, [{ op: "addSheet", title: "Next" }])
  expect(updated.sheets[1].id).toBe("sheet-3")
})

it("normalizes mixed-case references to canonical uppercase form", () => {
  const workbook = applyWorkbookOperations(createWorkbook("Case", "Data"), [
    { op: "setCell", sheet: "Data", cell: "b2", value: { type: "number", value: 3 } },
    {
      op: "setRange",
      sheet: "Data",
      range: "d4:e4",
      values: [
        [
          { type: "string", value: "x" },
          { type: "string", value: "y" },
        ],
      ],
    },
    { op: "merge", sheet: "Data", range: "a1:c1" },
    { op: "setFilter", sheet: "Data", range: "a1:e4" },
    { op: "setColumnDimension", sheet: "Data", column: "d", width: 14 },
  ])
  const sheet = workbook.sheets[0]
  expect(Object.keys(sheet.cells).sort()).toEqual(["B2", "D4", "E4"])
  expect(sheet.merges).toEqual(["A1:C1"])
  expect(sheet.filter).toBe("A1:E4")
  expect(sheet.columnDimensions).toMatchObject({ D: { width: 14 } })

  const unmerged = applyWorkbookOperations(workbook, [
    { op: "unmerge", sheet: "Data", range: "a1:c1" },
  ])
  expect(unmerged.sheets[0].merges).toEqual([])
})

it("inserts and deletes rows while remapping cells, merges, filter, freeze, and dimensions", () => {
  const base = applyWorkbookOperations(createWorkbook("Rows", "Data"), [
    {
      op: "setRange",
      sheet: "Data",
      range: "A1:A5",
      values: [1, 2, 3, 4, 5].map((value) => [{ type: "number" as const, value }]),
    },
    { op: "merge", sheet: "Data", range: "B2:B4" },
    { op: "setFilter", sheet: "Data", range: "A1:A5" },
    { op: "setFreeze", sheet: "Data", rows: 1 },
    { op: "setRowDimension", sheet: "Data", row: 3, height: 30 },
  ])

  const inserted = applyWorkbookOperations(base, [
    { op: "insertRows", sheet: "Data", row: 3, count: 2 },
  ])
  expect(Object.keys(inserted.sheets[0].cells)).toEqual(["A1", "A2", "A5", "A6", "A7"])
  expect(inserted.sheets[0].merges).toEqual(["B2:B6"])
  expect(inserted.sheets[0].filter).toBe("A1:A7")
  expect(inserted.sheets[0].freeze).toMatchObject({ rows: 1 })
  expect(inserted.sheets[0].rowDimensions).toMatchObject({ 5: { height: 30 } })

  const deleted = applyWorkbookOperations(base, [
    { op: "deleteRows", sheet: "Data", row: 2, count: 2 },
  ])
  expect(Object.keys(deleted.sheets[0].cells)).toEqual(["A1", "A2", "A3"])
  expect(deleted.sheets[0].cells.A2).toMatchObject({ value: 4 })
  // The merge collapses to one cell and is dropped.
  expect(deleted.sheets[0].merges).toEqual([])
  expect(deleted.sheets[0].filter).toBe("A1:A3")
  expect(deleted.sheets[0].freeze).toMatchObject({ rows: 1 })
  // The row-3 dimension entry was deleted with the row.
  expect(deleted.sheets[0].rowDimensions).toEqual({})
})

it("inserts and deletes columns while remapping cells, merges, filter, freeze, and dimensions", () => {
  const base = applyWorkbookOperations(createWorkbook("Cols", "Data"), [
    {
      op: "setRange",
      sheet: "Data",
      range: "A1:E1",
      values: [[1, 2, 3, 4, 5].map((value) => ({ type: "number" as const, value }))],
    },
    { op: "merge", sheet: "Data", range: "B2:D2" },
    { op: "setFilter", sheet: "Data", range: "A1:E1" },
    { op: "setFreeze", sheet: "Data", columns: 1 },
    { op: "setColumnDimension", sheet: "Data", column: "C", width: 20 },
  ])

  const inserted = applyWorkbookOperations(base, [
    { op: "insertColumns", sheet: "Data", column: "c", count: 2 },
  ])
  expect(Object.keys(inserted.sheets[0].cells)).toEqual(["A1", "B1", "E1", "F1", "G1"])
  expect(inserted.sheets[0].merges).toEqual(["B2:F2"])
  expect(inserted.sheets[0].filter).toBe("A1:G1")
  expect(inserted.sheets[0].freeze).toMatchObject({ columns: 1 })
  expect(inserted.sheets[0].columnDimensions).toMatchObject({ E: { width: 20 } })

  const deleted = applyWorkbookOperations(base, [
    { op: "deleteColumns", sheet: "Data", column: "B", count: 2 },
  ])
  expect(Object.keys(deleted.sheets[0].cells)).toEqual(["A1", "B1", "C1"])
  expect(deleted.sheets[0].cells.B1).toMatchObject({ value: 4 })
  // The merge collapses to one cell and is dropped.
  expect(deleted.sheets[0].merges).toEqual([])
  expect(deleted.sheets[0].filter).toBe("A1:C1")
  // The column-C dimension entry was deleted with the column.
  expect(deleted.sheets[0].columnDimensions).toEqual({})
})

it("clamps or drops ranges that intersect deleted spans", () => {
  const base = applyWorkbookOperations(createWorkbook("Clamp", "Data"), [
    { op: "merge", sheet: "Data", range: "A2:A8" },
    { op: "merge", sheet: "Data", range: "C3:C5" },
    { op: "merge", sheet: "Data", range: "E4:E6" },
    { op: "setFilter", sheet: "Data", range: "A1:F1" },
  ])
  const deleted = applyWorkbookOperations(base, [
    { op: "deleteRows", sheet: "Data", row: 3, count: 3 },
  ])
  // A2:A8 loses rows 3-5 → A2:A5; C3:C5 is fully deleted; E4:E6 keeps only
  // E6, which shifts up to E3 and drops as a single-cell merge.
  expect(deleted.sheets[0].merges).toEqual(["A2:A5"])
  expect(deleted.sheets[0].filter).toBe("A1:F1")

  const gone = applyWorkbookOperations(base, [
    { op: "deleteRows", sheet: "Data", row: 1, count: 8 },
  ])
  expect(gone.sheets[0].merges).toEqual([])
  expect(gone.sheets[0].filter).toBeUndefined()
  expect(gone.sheets[0].freeze).toBeUndefined()
})

it("shrinks the frozen pane when frozen rows are deleted and expands it on insert", () => {
  const base = applyWorkbookOperations(createWorkbook("Freeze", "Data"), [
    { op: "setFreeze", sheet: "Data", rows: 4, columns: 2 },
  ])
  expect(
    applyWorkbookOperations(base, [{ op: "deleteRows", sheet: "Data", row: 2, count: 3 }]).sheets[0]
      .freeze
  ).toMatchObject({ rows: 1 })
  expect(
    applyWorkbookOperations(base, [{ op: "insertRows", sheet: "Data", row: 2, count: 2 }]).sheets[0]
      .freeze
  ).toMatchObject({ rows: 6 })
  // Inserting at the freeze boundary leaves the frozen span unchanged.
  expect(
    applyWorkbookOperations(base, [{ op: "insertRows", sheet: "Data", row: 5, count: 2 }]).sheets[0]
      .freeze
  ).toMatchObject({ rows: 4 })
})

it.each([
  ["row index zero", { op: "insertRows" as const, sheet: "Sheet1", row: 0 }, "between 1 and"],
  [
    "row beyond bounds",
    { op: "deleteRows" as const, sheet: "Sheet1", row: 1048577 },
    "between 1 and",
  ],
  [
    "column beyond XFD",
    { op: "insertColumns" as const, sheet: "Sheet1", column: "XFE" },
    "invalid column",
  ],
  [
    "zero count",
    { op: "insertRows" as const, sheet: "Sheet1", row: 1, count: 0 },
    "positive integer",
  ],
  [
    "insert beyond bounds",
    { op: "insertRows" as const, sheet: "Sheet1", row: 1, count: 1048576 },
    "beyond the worksheet bounds",
  ],
] as const)("rejects structural edit: %s", (_name, operation, message) => {
  const workbook = applyWorkbookOperations(createWorkbook("x"), [
    { op: "setCell", sheet: "Sheet1", cell: "A1", value: { type: "string", value: "v" } },
  ])
  expect(() => applyWorkbookOperations(workbook, [operation])).toThrow(message)
})

describe("formula references follow structural edits", () => {
  const base = () =>
    applyWorkbookOperations(createWorkbook("Refs", "Data"), [
      {
        op: "setRange",
        sheet: "Data",
        range: "A1:B3",
        values: [
          [
            { type: "number", value: 1 },
            { type: "number", value: 10, formula: "A1*10" },
          ],
          [
            { type: "number", value: 2 },
            { type: "number", value: 20, formula: "A2*10" },
          ],
          [
            { type: "number", value: 3 },
            { type: "number", value: 60, formula: "SUM(B1:B2)" },
          ],
        ],
      },
      { op: "addSheet", title: "Summary" },
      {
        op: "setCell",
        sheet: "Summary",
        cell: "A1",
        value: { type: "number", value: 60, formula: "Data!B3" },
      },
    ])

  it("shifts formulas on the edited sheet and on sheets that read it", () => {
    const inserted = applyWorkbookOperations(base(), [{ op: "insertRows", sheet: "Data", row: 2 }])
    const data = inserted.sheets[0].cells
    expect(data.B1.formula).toBe("A1*10")
    expect(data.B3.formula).toBe("A3*10")
    expect(data.B4.formula).toBe("SUM(B1:B3)")
    expect(inserted.sheets[1].cells.A1.formula).toBe("Data!B4")
  })

  it("turns references into deleted rows into #REF!", () => {
    const deleted = applyWorkbookOperations(base(), [{ op: "deleteRows", sheet: "Data", row: 1 }])
    const data = deleted.sheets[0].cells
    expect(data.B1.formula).toBe("A1*10")
    expect(data.B2.formula).toBe("SUM(B1:B1)")
    expect(deleted.sheets[1].cells.A1.formula).toBe("Data!B2")
    const column = applyWorkbookOperations(base(), [
      { op: "deleteColumns", sheet: "Data", column: "A" },
    ])
    expect(column.sheets[0].cells.A1.formula).toBe("#REF!*10")
  })

  it("renames and deletes sheet references across the workbook", () => {
    const renamed = applyWorkbookOperations(base(), [
      { op: "renameSheet", sheet: "Data", title: "Raw data" },
    ])
    expect(renamed.sheets[1].cells.A1.formula).toBe("'Raw data'!B3")
    const deleted = applyWorkbookOperations(base(), [{ op: "deleteSheet", sheet: "Data" }])
    expect(deleted.sheets[0].cells.A1.formula).toBe("#REF!")
  })
})

describe("merges", () => {
  it("refuses overlapping and single-cell merges and unmerges by intersection", () => {
    const merged = applyWorkbookOperations(createWorkbook("M"), [
      { op: "merge", sheet: "Sheet1", range: "A1:B2" },
      { op: "merge", sheet: "Sheet1", range: "D1:E1" },
    ])
    expect(() =>
      applyWorkbookOperations(merged, [{ op: "merge", sheet: "Sheet1", range: "B2:C3" }])
    ).toThrow("overlaps the merged range A1:B2")
    expect(() =>
      applyWorkbookOperations(merged, [{ op: "merge", sheet: "Sheet1", range: "C5:C5" }])
    ).toThrow("at least two cells")
    const released = applyWorkbookOperations(merged, [
      { op: "unmerge", sheet: "Sheet1", range: "B2" },
    ])
    expect(released.sheets[0].merges).toEqual(["D1:E1"])
  })

  it("reports stored overlaps as errors but still opens the workbook so it can be repaired", () => {
    const workbook = createWorkbook("Broken")
    workbook.sheets[0].merges = ["A1:B2", "B2:C3"]
    expect(validateWorkbook(workbook)).toContainEqual(
      expect.objectContaining({ severity: "error", code: "merge.overlap" })
    )
    const parsed = parseWorkbook(JSON.stringify(workbook))
    expect(() =>
      applyWorkbookOperations(parsed, [
        { op: "setCell", sheet: "Sheet1", cell: "Z1", value: { type: "string", value: "x" } },
      ])
    ).toThrow("merge.overlap")
    const repaired = applyWorkbookOperations(parsed, [
      { op: "unmerge", sheet: "Sheet1", range: "C3" },
    ])
    expect(repaired.sheets[0].merges).toEqual(["A1:B2"])
  })
})

describe("range operations", () => {
  const seeded = () =>
    applyWorkbookOperations(createWorkbook("Range"), [
      {
        op: "setRange",
        sheet: "Sheet1",
        range: "A1:B2",
        values: [
          [
            { type: "string", value: "Item", style: { font: { bold: true } } },
            { type: "string", value: "Qty", style: { font: { bold: true } } },
          ],
          [
            { type: "string", value: "Pen" },
            { type: "number", value: 3 },
          ],
        ],
      },
    ])

  it("clears whole cells, contents only, or formats only", () => {
    const all = applyWorkbookOperations(seeded(), [
      { op: "clearRange", sheet: "Sheet1", range: "A1:B1" },
    ])
    expect(Object.keys(all.sheets[0].cells).sort()).toEqual(["A2", "B2"])
    const contents = applyWorkbookOperations(seeded(), [
      { op: "clearRange", sheet: "Sheet1", range: "A1:B2", target: "contents" },
    ])
    expect(contents.sheets[0].cells).toEqual({
      A1: { type: "blank", style: { font: { bold: true } } },
      B1: { type: "blank", style: { font: { bold: true } } },
    })
    const formats = applyWorkbookOperations(seeded(), [
      { op: "clearRange", sheet: "Sheet1", range: "A1", target: "formats" },
    ])
    expect(formats.sheets[0].cells.A1).toEqual({ type: "string", value: "Item" })
  })

  it("styles a range by merging or replacing, and bounds its size", () => {
    const styled = applyWorkbookOperations(seeded(), [
      {
        op: "setRangeStyle",
        sheet: "Sheet1",
        range: "A1:C1",
        style: { fill: { color: "D9EAF7" }, font: { italic: true } },
      },
    ])
    expect(styled.sheets[0].cells.A1.style).toEqual({
      font: { bold: true, italic: true },
      fill: { color: "D9EAF7" },
    })
    // An empty cell in the range is materialized as a styled blank.
    expect(styled.sheets[0].cells.C1).toEqual({
      type: "blank",
      style: { fill: { color: "D9EAF7" }, font: { italic: true } },
    })
    const replaced = applyWorkbookOperations(styled, [
      {
        op: "setRangeStyle",
        sheet: "Sheet1",
        range: "A1:C1",
        style: { numberFormat: "0.00" },
        mode: "replace",
      },
    ])
    expect(replaced.sheets[0].cells.A1.style).toEqual({ numberFormat: "0.00" })
    // Replacing with an empty style drops blank cells that only held formatting.
    const reset = applyWorkbookOperations(replaced, [
      { op: "setRangeStyle", sheet: "Sheet1", range: "C1", style: {}, mode: "replace" },
    ])
    expect(reset.sheets[0].cells.C1).toBeUndefined()
    expect(() =>
      applyWorkbookOperations(seeded(), [
        { op: "setRangeStyle", sheet: "Sheet1", range: "A1:A1048576", style: {} },
      ])
    ).toThrow("at most 100000")
  })

  it("appends ragged rows below the used range, from a chosen column", () => {
    const appended = applyWorkbookOperations(seeded(), [
      {
        op: "appendRows",
        sheet: "Sheet1",
        rows: [
          [
            { type: "string", value: "Ink" },
            { type: "number", value: 5 },
          ],
          [{ type: "string", value: "Note" }],
        ],
      },
      {
        op: "appendRows",
        sheet: "Sheet1",
        column: "b",
        rows: [[{ type: "number", value: 9, formula: "=SUM(B2:B3)" }]],
      },
    ])
    const cells = appended.sheets[0].cells
    expect(cells.A3).toEqual({ type: "string", value: "Ink" })
    expect(cells.B3).toEqual({ type: "number", value: 5 })
    expect(cells.A4).toEqual({ type: "string", value: "Note" })
    expect(cells.B5).toEqual({ type: "number", value: 9, formula: "SUM(B2:B3)" })
    const empty = applyWorkbookOperations(createWorkbook("Empty"), [
      { op: "appendRows", sheet: "Sheet1", rows: [[{ type: "string", value: "first" }]] },
    ])
    expect(empty.sheets[0].cells.A1).toEqual({ type: "string", value: "first" })
  })
})

it("summarizes sheets with their used range instead of their cells", () => {
  const workbook = applyWorkbookOperations(createWorkbook("Summary", "Data"), [
    { op: "setCell", sheet: "Data", cell: "B2", value: { type: "number", value: 1 } },
    {
      op: "setCell",
      sheet: "Data",
      cell: "C4",
      value: { type: "number", value: 2, formula: "B2*2" },
    },
    { op: "merge", sheet: "Data", range: "E1:F1" },
    { op: "setFreeze", sheet: "Data", rows: 1 },
    { op: "addSheet", title: "Empty" },
  ])
  expect(usedRange(workbook.sheets[0])).toBe("B1:F4")
  expect(summarizeWorkbook(workbook)).toEqual({
    title: "Summary",
    sheets: [
      {
        id: "sheet-1",
        title: "Data",
        usedRange: "B1:F4",
        cellCount: 2,
        formulaCount: 1,
        merges: 1,
        freeze: { rows: 1 },
      },
      { id: "sheet-2", title: "Empty", cellCount: 0, formulaCount: 0, merges: 0 },
    ],
    unsupportedFeatures: [],
  })
})

it("names every operation the model accepts", () => {
  expect(WORKBOOK_OPERATION_NAMES).toHaveLength(new Set(WORKBOOK_OPERATION_NAMES).size)
  expect(WORKBOOK_OPERATION_NAMES).toEqual(
    expect.arrayContaining(["clearRange", "setRangeStyle", "appendRows"])
  )
})

const rangeOperationErrors: Array<[string, WorkbookOperation, string]> = [
  ["appendRows without rows", { op: "appendRows", sheet: "Sheet1", rows: [] }, "at least one row"],
  [
    "appendRows past the last column",
    {
      op: "appendRows",
      sheet: "Sheet1",
      column: "XFD",
      rows: [
        [
          { type: "string", value: "a" },
          { type: "string", value: "b" },
        ],
      ],
    },
    "beyond the worksheet bounds",
  ],
  [
    "an unknown style mode",
    {
      op: "setRangeStyle",
      sheet: "Sheet1",
      range: "A1",
      style: {},
      // Deliberately outside the union: the model must reject it at runtime.
      mode: "blend" as never,
    },
    "invalid style mode",
  ],
  [
    "an unknown clear target",
    { op: "clearRange", sheet: "Sheet1", range: "A1", target: "values" as never },
    "invalid clear target",
  ],
  [
    "an invalid clear range",
    { op: "clearRange", sheet: "Sheet1", range: "B2:A1" },
    "invalid range",
  ],
]

it.each(rangeOperationErrors)("rejects range operation: %s", (_name, operation, message) => {
  expect(() => applyWorkbookOperations(createWorkbook("x"), [operation])).toThrow(message)
})
