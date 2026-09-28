import {
  applyDocumentOperations,
  createDocument,
  DOCUMENT_OPERATION_NAMES,
  parseDocument,
  summarizeDocument,
  validateDocument,
  type DocumentModel,
  type DocumentOperation,
} from "./model"

it("applies document edits, tracked changes, comments, and review actions", () => {
  const created = applyDocumentOperations(createDocument("Proposal", "Before"), [
    { op: "replaceText", blockId: "b1", text: "After", trackChange: true },
    { op: "addComment", blockId: "b1", text: "Verify this", author: "Reviewer" },
    { op: "acceptAllChanges" },
  ])
  expect(created.blocks[0]).toMatchObject({ text: "After" })
  expect(created.changes[0]).toMatchObject({ before: "Before", after: "After", accepted: true })
  expect(created.comments[0]).toMatchObject({ text: "Verify this" })
  expect(validateDocument(created)).toEqual([])
})

it("setTitle updates the title and trims whitespace", () => {
  const model = applyDocumentOperations(createDocument("Old"), [
    { op: "setTitle", title: "  New Title  " },
  ])
  expect(model.title).toBe("New Title")
  expect(() => applyDocumentOperations(model, [{ op: "setTitle", title: "  " }])).toThrow(
    "title is required"
  )
})

it("insertBlock prepends, inserts after an anchor, and rejects bad anchors", () => {
  const model = applyDocumentOperations(createDocument("Doc", "First"), [
    { op: "insertBlock", block: { type: "paragraph", text: "Prepended" } },
    {
      op: "insertBlock",
      afterBlockId: "b1",
      block: { type: "heading", level: 2, text: "Middle" },
    },
  ])
  expect(model.blocks.map((block) => block.type)).toEqual(["paragraph", "paragraph", "heading"])
  expect(model.blocks[2].id).not.toBe(model.blocks[0].id)
  expect(() =>
    applyDocumentOperations(model, [
      { op: "insertBlock", afterBlockId: "missing", block: { type: "paragraph", text: "x" } },
    ])
  ).toThrow("Insert anchor block not found")
})

it("deleteBlock removes the block plus its comments and pending changes", () => {
  const model = applyDocumentOperations(createDocument("Doc", "Target"), [
    { op: "appendParagraph", text: "Keep" },
    { op: "addComment", blockId: "b1", text: "note" },
    { op: "replaceText", blockId: "b1", text: "Changed", trackChange: true },
    { op: "deleteBlock", blockId: "b1" },
  ])
  expect(model.blocks).toHaveLength(1)
  expect(model.blocks[0].id).toBe("b2")
  expect(model.comments).toHaveLength(0)
  expect(model.changes).toHaveLength(0)
})

it("moveBlock reorders blocks and clamps the target index", () => {
  const model = applyDocumentOperations(createDocument("Doc", "A"), [
    { op: "appendParagraph", text: "B" },
    { op: "appendParagraph", text: "C" },
    { op: "moveBlock", blockId: "b3", toIndex: 0 },
  ])
  expect(model.blocks.map((block) => block.id)).toEqual(["b3", "b1", "b2"])
  const clamped = applyDocumentOperations(model, [{ op: "moveBlock", blockId: "b3", toIndex: 99 }])
  expect(clamped.blocks.map((block) => block.id)).toEqual(["b1", "b2", "b3"])
})

it("updateTableCell edits a cell and bounds-checks coordinates", () => {
  const model = applyDocumentOperations(createDocument("Doc"), [
    {
      op: "appendTable",
      rows: [
        ["A", "B"],
        ["1", "2"],
      ],
    },
    { op: "updateTableCell", blockId: "b1", row: 1, column: 0, text: "3" },
  ])
  const table = model.blocks[0]
  expect(table.type === "table" && table.rows[1][0]).toBe("3")
  expect(() =>
    applyDocumentOperations(model, [
      { op: "updateTableCell", blockId: "b1", row: 9, column: 0, text: "x" },
    ])
  ).toThrow("Table cell out of range")
})

it("acceptChange and rejectChange resolve single tracked changes", () => {
  const base = applyDocumentOperations(createDocument("Doc", "v1"), [
    { op: "replaceText", blockId: "b1", text: "v2", trackChange: true },
    { op: "appendParagraph", text: "other" },
  ])
  const otherId = base.blocks[1].id
  const withSecondChange = applyDocumentOperations(base, [
    { op: "replaceText", blockId: otherId, text: "other v2", trackChange: true },
  ])
  const accepted = applyDocumentOperations(withSecondChange, [
    { op: "acceptChange", changeId: withSecondChange.changes[0].id },
  ])
  expect(accepted.changes[0].accepted).toBe(true)
  const rejected = applyDocumentOperations(withSecondChange, [
    { op: "rejectChange", changeId: withSecondChange.changes[1].id },
  ])
  const restored = rejected.blocks.find((block) => block.id === otherId)
  expect(restored && "text" in restored && restored.text).toBe("other")
  expect(rejected.changes.map((change) => change.id)).toEqual([withSecondChange.changes[0].id])
})

it("rejectChange restores the earliest pending before in a change chain", () => {
  const base = applyDocumentOperations(createDocument("Doc", "v1"), [
    { op: "replaceText", blockId: "b1", text: "v2", trackChange: true },
    { op: "replaceText", blockId: "b1", text: "v3", trackChange: true },
  ])
  // Rejecting the newest change restores the previous pending text.
  const rejectLatest = applyDocumentOperations(base, [
    { op: "rejectChange", changeId: base.changes[1].id },
  ])
  expect(rejectLatest.blocks[0]).toMatchObject({ text: "v2" })
  // Rejecting the earliest drops its record without stomping the later edit.
  const rejectEarliest = applyDocumentOperations(base, [
    { op: "rejectChange", changeId: base.changes[0].id },
  ])
  expect(rejectEarliest.blocks[0]).toMatchObject({ text: "v3" })
})

it("rejectAllChanges restores pre-change text per block and keeps accepted history", () => {
  const model = applyDocumentOperations(createDocument("Doc", "v1"), [
    { op: "replaceText", blockId: "b1", text: "v2", trackChange: true },
    { op: "acceptAllChanges" },
    { op: "replaceText", blockId: "b1", text: "v3", trackChange: true },
    { op: "rejectAllChanges" },
  ])
  expect(model.blocks[0]).toMatchObject({ text: "v2" })
  expect(model.changes.every((change) => change.accepted)).toBe(true)
})

it("resolveComment and reopenComment toggle comment state", () => {
  const model = applyDocumentOperations(createDocument("Doc", "x"), [
    { op: "addComment", blockId: "b1", text: "note" },
  ])
  const commentId = model.comments[0].id
  const resolved = applyDocumentOperations(model, [{ op: "resolveComment", commentId }])
  expect(resolved.comments[0].resolved).toBe(true)
  const reopened = applyDocumentOperations(resolved, [{ op: "reopenComment", commentId }])
  expect(reopened.comments[0].resolved).toBe(false)
})

it("rejects a double-accepted change and unknown review ids", () => {
  const model = applyDocumentOperations(createDocument("Doc", "x"), [
    { op: "replaceText", blockId: "b1", text: "y", trackChange: true },
    { op: "acceptAllChanges" },
  ])
  expect(() =>
    applyDocumentOperations(model, [{ op: "rejectChange", changeId: model.changes[0].id }])
  ).toThrow("Change already accepted")
  expect(() =>
    applyDocumentOperations(model, [{ op: "resolveComment", commentId: "nope" }])
  ).toThrow("Comment not found")
})

it("allocates unique ids after blocks and review entries are deleted", () => {
  const model = applyDocumentOperations(createDocument("Doc", "a"), [
    { op: "appendParagraph", text: "b" },
    { op: "appendParagraph", text: "c" },
    { op: "addComment", blockId: "b2", text: "note" },
    { op: "deleteBlock", blockId: "b2" },
    { op: "appendParagraph", text: "d" },
  ])
  const ids = model.blocks.map((block) => block.id)
  expect(new Set(ids).size).toBe(ids.length)
  // The batch-start sequence (5) is never rewound by mid-batch deletions, so
  // the new block gets b5 — no id is ever reused within or across batches.
  expect(ids).toEqual(["b1", "b3", "b5"])
})

it("parseDocument validates structure beyond schemaVersion", () => {
  const model = createDocument("Doc", "hello")
  expect(parseDocument(JSON.stringify(model)).title).toBe("Doc")
  expect(() =>
    parseDocument(
      JSON.stringify({
        schemaVersion: 1,
        blocks: [{ id: "b1", type: "bogus" }],
        title: "x",
        comments: [],
        changes: [],
        importedFeatures: [],
      })
    )
  ).toThrow('type "bogus" is unsupported')
  expect(() =>
    parseDocument(
      JSON.stringify({
        schemaVersion: 1,
        title: "x",
        comments: [],
        changes: [],
        importedFeatures: [],
        blocks: [{ type: "paragraph", text: "no id" }],
      })
    )
  ).toThrow("id must be a non-empty string")
  expect(() =>
    parseDocument(
      JSON.stringify({
        schemaVersion: 1,
        title: "x",
        blocks: [{ id: "b1", type: "heading", level: 9, text: "h" }],
        comments: [],
        changes: [],
        importedFeatures: [],
      })
    )
  ).toThrow("level must be an integer from 1 to 6")
})

it("validateDocument catches orphan changes and duplicate review ids", () => {
  const model: DocumentModel = {
    schemaVersion: 1,
    title: "Doc",
    blocks: [{ id: "b1", type: "paragraph", text: "x" }],
    comments: [
      { id: "m1", blockId: "b1", text: "a", author: "A", resolved: false },
      { id: "m1", blockId: "b1", text: "b", author: "B", resolved: false },
    ],
    changes: [{ id: "c1", blockId: "gone", before: "a", after: "b", accepted: false }],
    importedFeatures: [],
  }
  const codes = validateDocument(model).map((finding) => finding.code)
  expect(codes).toContain("comment.duplicate_id")
  expect(codes).toContain("change.orphan")
})

it("validateDocument flags ragged tables and bad heading levels", () => {
  const model: DocumentModel = {
    schemaVersion: 1,
    title: "Doc",
    blocks: [
      { id: "b1", type: "heading", level: 7 as never, text: "h" },
      { id: "b2", type: "table", rows: [["a", "b"], ["c"]] },
      { id: "b3", type: "list-item", ordered: false, level: 9, text: "deep" },
    ],
    comments: [],
    changes: [],
    importedFeatures: [],
  }
  const codes = validateDocument(model).map((finding) => finding.code)
  expect(codes).toContain("block.heading_level")
  expect(codes).toContain("table.ragged")
  expect(codes).toContain("block.list_level")
})

describe("richer blocks", () => {
  it("creates headings 1–6, nested list items, quotes, and code, and validates them", () => {
    const model = applyDocumentOperations(createDocument("Blocks"), [
      { op: "appendHeading", level: 6, text: "Deep heading" },
      { op: "appendListItem", text: "nested", level: 2 },
      { op: "insertBlock", block: { type: "quote", text: "  Quoted  " } },
      {
        op: "insertBlock",
        afterBlockId: "b2",
        block: { type: "code", text: "  indented()\n\n", language: " ts " },
      },
    ])
    expect(model.blocks).toEqual([
      { id: "b3", type: "quote", text: "Quoted" },
      { id: "b1", type: "heading", level: 6, text: "Deep heading" },
      { id: "b2", type: "list-item", ordered: false, level: 2, text: "nested" },
      { id: "b4", type: "code", text: "  indented()", language: "ts" },
    ])
    expect(validateDocument(model)).toEqual([])
    expect(parseDocument(JSON.stringify(model)).blocks).toHaveLength(4)
    expect(() =>
      applyDocumentOperations(model, [{ op: "appendListItem", text: "x", level: 9 }])
    ).toThrow("List level must be an integer from 0 to 8")
    expect(() =>
      applyDocumentOperations(model, [
        { op: "insertBlock", block: { type: "code", text: "  \n " } },
      ])
    ).toThrow("text is required")
  })

  it("rejects malformed code blocks when parsing", () => {
    const bad = {
      ...createDocument("x"),
      blocks: [{ id: "b1", type: "code", text: "x", language: 3 }],
    }
    expect(() => parseDocument(JSON.stringify(bad))).toThrow("language must be a string")
  })
})

describe("markdown operations", () => {
  it("appends and inserts parsed blocks with fresh ids", () => {
    const model = applyDocumentOperations(createDocument("Doc", "Intro"), [
      { op: "appendMarkdown", markdown: "## Scope\n\n- a\n- b" },
      { op: "insertMarkdown", afterBlockId: "b1", markdown: "> note" },
      { op: "insertMarkdown", markdown: "# Top" },
    ])
    expect(model.blocks.map((block) => [block.id, block.type])).toEqual([
      ["b6", "heading"],
      ["b1", "paragraph"],
      ["b5", "quote"],
      ["b2", "heading"],
      ["b3", "list-item"],
      ["b4", "list-item"],
    ])
    expect(() =>
      applyDocumentOperations(model, [{ op: "appendMarkdown", markdown: "---" }])
    ).toThrow("Markdown produced no document blocks")
    expect(() =>
      applyDocumentOperations(model, [
        { op: "insertMarkdown", afterBlockId: "nope", markdown: "x" },
      ])
    ).toThrow("Insert anchor block not found")
  })
})

describe("replaceBlock", () => {
  it("changes a block's type in place and keeps its comments", () => {
    const model = applyDocumentOperations(createDocument("Doc", "Heading text"), [
      { op: "addComment", blockId: "b1", text: "Promote this" },
      {
        op: "replaceBlock",
        blockId: "b1",
        block: { type: "heading", level: 2, text: "Heading text" },
      },
    ])
    expect(model.blocks).toEqual([{ id: "b1", type: "heading", level: 2, text: "Heading text" }])
    expect(model.comments[0].blockId).toBe("b1")
  })

  it("refuses to replace a block under a pending tracked change", () => {
    const model = applyDocumentOperations(createDocument("Doc", "Before"), [
      { op: "replaceText", blockId: "b1", text: "After", trackChange: true },
    ])
    expect(() =>
      applyDocumentOperations(model, [
        { op: "replaceBlock", blockId: "b1", block: { type: "quote", text: "x" } },
      ])
    ).toThrow("pending tracked changes")
    expect(() =>
      applyDocumentOperations(model, [
        { op: "replaceBlock", blockId: "missing", block: { type: "quote", text: "x" } },
      ])
    ).toThrow("Block not found")
  })
})

describe("findReplace", () => {
  const base = () =>
    applyDocumentOperations(createDocument("Doc", "Acme ships Acme-grade parts."), [
      { op: "appendListItem", text: "acme support" },
      { op: "appendTable", rows: [["Vendor"], ["Acme"]] },
      { op: "appendParagraph", text: "Acmecorp is unrelated." },
    ])

  it("replaces across text blocks and table cells, case-insensitively by default", () => {
    const model = applyDocumentOperations(base(), [
      { op: "findReplace", find: "acme", replace: "Globex", wholeWord: true },
    ])
    expect(model.blocks.map((block) => (block.type === "table" ? block.rows : block.text))).toEqual(
      [
        "Globex ships Globex-grade parts.",
        "Globex support",
        [["Vendor"], ["Globex"]],
        "Acmecorp is unrelated.",
      ]
    )
    const cased = applyDocumentOperations(base(), [
      { op: "findReplace", find: "Acme", replace: "X", matchCase: true },
    ])
    expect(cased.blocks[1]).toMatchObject({ text: "acme support" })
    expect(cased.blocks[3]).toMatchObject({ text: "Xcorp is unrelated." })
  })

  it("records one tracked change per edited text block and treats regex characters literally", () => {
    const model = applyDocumentOperations(createDocument("Doc", "Cost (USD) is $5.00"), [
      { op: "findReplace", find: "$5.00", replace: "$6.00", trackChanges: true },
    ])
    expect(model.blocks[0]).toMatchObject({ text: "Cost (USD) is $6.00" })
    expect(model.changes).toEqual([
      expect.objectContaining({
        blockId: "b1",
        before: "Cost (USD) is $5.00",
        after: "Cost (USD) is $6.00",
        accepted: false,
      }),
    ])
  })

  it("matches whole words next to punctuation, emoji, and CJK without lookbehind", () => {
    const model = applyDocumentOperations(createDocument("Doc", "cat, 🐱cat catalog 猫cat cat"), [
      { op: "findReplace", find: "cat", replace: "dog", wholeWord: true },
    ])
    // "猫cat" is one word (猫 is a letter); the emoji is not a word character.
    expect(model.blocks[0]).toMatchObject({ text: "dog, 🐱dog catalog 猫cat dog" })
  })

  it("refuses to find nothing or to empty a block", () => {
    expect(() =>
      applyDocumentOperations(base(), [{ op: "findReplace", find: "zzz", replace: "y" }])
    ).toThrow('found no match for "zzz"')
    expect(() =>
      applyDocumentOperations(createDocument("Doc", "Only"), [
        { op: "findReplace", find: "Only", replace: "" },
      ])
    ).toThrow("would empty block b1")
  })
})

describe("table structure", () => {
  const table = () =>
    applyDocumentOperations(createDocument("Doc"), [
      {
        op: "appendTable",
        rows: [
          ["A", "B"],
          ["1", "2"],
        ],
      },
    ])

  it("inserts and deletes rows and columns", () => {
    const model = applyDocumentOperations(table(), [
      { op: "insertTableRow", blockId: "b1", index: 1, cells: ["x", "y"] },
      { op: "insertTableRow", blockId: "b1", index: 3 },
      { op: "insertTableColumn", blockId: "b1", index: 1, cells: ["M", "m", "n", "o"] },
      { op: "deleteTableColumn", blockId: "b1", index: 0 },
      { op: "deleteTableRow", blockId: "b1", index: 2 },
    ])
    expect(model.blocks[0]).toMatchObject({
      rows: [
        ["M", "B"],
        ["m", "y"],
        ["o", ""],
      ],
    })
  })

  it("pads ragged rows before a column edit and bounds every index", () => {
    const ragged = table()
    ;(ragged.blocks[0] as { rows: string[][] }).rows.push(["only"])
    const widened = applyDocumentOperations(ragged, [
      { op: "insertTableColumn", blockId: "b1", index: 2 },
    ])
    expect(widened.blocks[0]).toMatchObject({
      rows: [
        ["A", "B", ""],
        ["1", "2", ""],
        ["only", "", ""],
      ],
    })
    const cases: Array<[DocumentOperation, string]> = [
      [{ op: "insertTableRow", blockId: "b1", index: 9 }, "row index out of range"],
      [{ op: "insertTableRow", blockId: "b1", index: 0, cells: ["a"] }, "needs 2 cells"],
      [{ op: "deleteTableRow", blockId: "b1", index: 5 }, "row index out of range"],
      [{ op: "insertTableColumn", blockId: "b1", index: 3 }, "column index out of range"],
      [{ op: "insertTableColumn", blockId: "b1", index: 0, cells: ["a"] }, "needs 2 cells"],
      [{ op: "deleteTableColumn", blockId: "b1", index: 2 }, "column index out of range"],
      [{ op: "deleteTableRow", blockId: "missing", index: 0 }, "Table block not found"],
    ]
    for (const [operation, message] of cases)
      expect(() => applyDocumentOperations(table(), [operation])).toThrow(message)
  })

  it("refuses to delete a table's last row or column", () => {
    const single = applyDocumentOperations(createDocument("Doc"), [
      { op: "appendTable", rows: [["only"]] },
    ])
    expect(() =>
      applyDocumentOperations(single, [{ op: "deleteTableRow", blockId: "b1", index: 0 }])
    ).toThrow("delete the block")
    expect(() =>
      applyDocumentOperations(single, [{ op: "deleteTableColumn", blockId: "b1", index: 0 }])
    ).toThrow("delete the block")
  })
})

it("summarizes a document with counts and an id outline instead of its text", () => {
  const long = "word ".repeat(40)
  const model = applyDocumentOperations(createDocument("Summary"), [
    { op: "appendHeading", level: 2, text: "Scope" },
    { op: "appendParagraph", text: long },
    { op: "appendListItem", text: "nested", level: 1 },
    {
      op: "appendTable",
      rows: [
        ["a", "b"],
        ["c", "d"],
      ],
    },
    { op: "addComment", blockId: "b1", text: "?" },
    { op: "replaceText", blockId: "b1", text: "Scope v2", trackChange: true },
  ])
  const summary = summarizeDocument(model, 3)
  expect(summary).toMatchObject({
    title: "Summary",
    blockCount: 4,
    blockTypes: { heading: 1, paragraph: 1, "list-item": 1, table: 1 },
    comments: { open: 1, resolved: 0 },
    changes: { pending: 1, accepted: 0 },
    outlineTruncated: true,
    importedFeatures: [],
  })
  expect(summary.outline).toEqual([
    { id: "b1", type: "heading", level: 2, text: "Scope v2" },
    { id: "b2", type: "paragraph", text: `${"word ".repeat(15)}word…` },
    { id: "b3", type: "list-item", level: 1, text: "nested" },
  ])
  expect(summarizeDocument(model).outline[3]).toEqual({
    id: "b4",
    type: "table",
    text: "a | b / c | d",
  })
})

it("rejects unknown operations and names every supported one", () => {
  expect(() =>
    applyDocumentOperations(createDocument("Doc"), [{ op: "explode" } as never])
  ).toThrow("Unsupported document operation: explode")
  expect(new Set(DOCUMENT_OPERATION_NAMES).size).toBe(DOCUMENT_OPERATION_NAMES.length)
})

it("stripComments removes every comment and keeps tracked changes", () => {
  const model = applyDocumentOperations(createDocument("Doc", "Text"), [
    { op: "addComment", blockId: "b1", text: "one" },
    { op: "addComment", blockId: "b1", text: "two" },
    { op: "replaceText", blockId: "b1", text: "New", trackChange: true },
    { op: "stripComments" },
  ])
  expect(model.comments).toEqual([])
  expect(model.changes).toHaveLength(1)
})

it("rejects an unsupported block type on insert", () => {
  expect(() =>
    applyDocumentOperations(createDocument("Doc"), [
      { op: "insertBlock", block: { type: "image", text: "x" } as never },
    ])
  ).toThrow("Unsupported block type: image")
})
