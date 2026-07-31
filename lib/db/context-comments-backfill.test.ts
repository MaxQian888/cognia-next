import { contextCommentRowFromCanvas } from "./context-comments-backfill"

it("maps a Canvas comment into the generalized resource and anchor columns", () => {
  expect(
    contextCommentRowFromCanvas({
      id: "comment-1",
      documentId: "doc-1",
      projectId: "project-1",
      authorId: "user-1",
      authorName: "Maya",
      content: "Check this",
      range: { startLine: 4, startColumn: 2, endLine: 5, endColumn: 8 },
      reactions: [{ emoji: "👍", users: ["user-2"] }],
      createdAt: 100,
    })
  ).toEqual(
    expect.objectContaining({
      id: "comment-1",
      resourceKind: "canvas-document",
      resourceId: "doc-1",
      projectId: "project-1",
      anchor: expect.objectContaining({
        kind: "text-range",
        lineRange: { startLine: 4, startColumn: 2, endLine: 5, endColumn: 8 },
      }),
    })
  )
})
