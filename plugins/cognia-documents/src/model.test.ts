import { applyDocumentOperations, createDocument, validateDocument } from "./model"

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
