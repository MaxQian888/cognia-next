import {
  applyDocumentOperations,
  createDocument,
  parseDocument,
  validateDocument,
  type DocumentModel,
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
  ).toThrow("level must be 1, 2, or 3")
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
      { id: "b1", type: "heading", level: 5 as never, text: "h" },
      { id: "b2", type: "table", rows: [["a", "b"], ["c"]] },
    ],
    comments: [],
    changes: [],
    importedFeatures: [],
  }
  const codes = validateDocument(model).map((finding) => finding.code)
  expect(codes).toContain("block.heading_level")
  expect(codes).toContain("table.ragged")
})
