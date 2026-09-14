import { applyWorkbookOperations, createWorkbook, parseWorkbook, validateWorkbook } from "./model"

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
    freeze: {},
    rowDimensions: { 2: { height: 18, hidden: true } },
    columnDimensions: { B: { width: 12, hidden: true } },
  })
  expect(workbook.sheets[0].filter).toBeUndefined()
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
