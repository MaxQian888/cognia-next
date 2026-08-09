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
    "positive integer",
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
