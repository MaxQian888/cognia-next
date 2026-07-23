/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import type { CanvasCommentRow } from "./canvas-types"
import { __resetDbForTesting, getDb, whenSeeded } from "./schema"
import {
  addContextComment,
  addContextCommentReaction,
  bulkImportContextComments,
  contextCommentRowFromCanvas,
  deleteContextComment,
  listContextCommentsForResource,
  listUnresolvedContextComments,
  removeContextCommentReaction,
  reopenContextComment,
  replyToContextComment,
  resolveContextComment,
  updateContextComment,
} from "./context-comments"
import { isContextCommentAnchorStale } from "@/types/context-comment"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

describe("context-comments", () => {
  it("supports every anchor kind and reports revision drift", async () => {
    const anchors = [
      { kind: "resource" as const, revision: "r1" },
      { kind: "text-range" as const, start: 1, end: 4, revision: "r1" },
      { kind: "workflow-node" as const, nodeId: "node-1", revision: "r1" },
      { kind: "workflow-edge" as const, edgeId: "edge-1", revision: "r1" },
    ]
    for (const anchor of anchors) {
      const comment = await addContextComment({
        resource: { kind: "workflow", id: "wf-1", projectId: "project-1" },
        anchor,
        authorId: "user-1",
        authorName: "Maya",
        content: anchor.kind,
      })
      expect(isContextCommentAnchorStale(comment, "r1")).toBe(false)
      expect(isContextCommentAnchorStale(comment, "r2")).toBe(true)
    }
    expect(await listContextCommentsForResource("workflow", "wf-1")).toHaveLength(4)
  })

  it("preserves thread, edit, reaction, resolve, reopen, and cascade-delete behavior", async () => {
    const root = await addContextComment({
      resource: { kind: "artifact", id: "artifact-1" },
      anchor: { kind: "resource", revision: "v1" },
      authorId: "user-1",
      authorName: "Maya",
      content: "Root",
    })
    const reply = await replyToContextComment(root.id, {
      authorId: "user-2",
      authorName: "Sam",
      content: "Reply",
    })
    expect(reply).toMatchObject({ parentId: root.id, resourceId: "artifact-1" })

    await updateContextComment(root.id, "Edited")
    await addContextCommentReaction(root.id, "👍", "user-1")
    await addContextCommentReaction(root.id, "👍", "user-1")
    await addContextCommentReaction(root.id, "👍", "user-2")
    await removeContextCommentReaction(root.id, "👍", "user-1")
    await resolveContextComment(root.id, "user-2")
    expect(await listUnresolvedContextComments("artifact", "artifact-1")).toEqual([])
    await reopenContextComment(root.id)

    const [reloaded] = await listContextCommentsForResource("artifact", "artifact-1")
    expect(reloaded).toMatchObject({ content: "Edited", resolvedAt: undefined })
    expect(reloaded?.reactions).toEqual([{ emoji: "👍", users: ["user-2"] }])

    await deleteContextComment(root.id)
    expect(await listContextCommentsForResource("artifact", "artifact-1")).toEqual([])
  })

  it("idempotently converts and imports legacy Canvas rows", async () => {
    const legacy: CanvasCommentRow = {
      id: "canvas-comment-1",
      documentId: "doc-1",
      projectId: "project-1",
      authorId: "user-1",
      authorName: "Maya",
      content: "Legacy",
      range: { startLine: 2, startColumn: 1, endLine: 3, endColumn: 4 },
      reactions: [],
      createdAt: 100,
    }
    const converted = contextCommentRowFromCanvas(legacy)
    expect(converted).toMatchObject({
      id: legacy.id,
      resourceKind: "canvas-document",
      resourceId: "doc-1",
      projectId: "project-1",
      anchor: { kind: "text-range", lineRange: legacy.range },
    })
    expect(await bulkImportContextComments([converted])).toBe(1)
    expect(await bulkImportContextComments([converted])).toBe(0)
  })

  it("orders roots before replies when their timestamps are identical", async () => {
    const createdAt = 123
    await bulkImportContextComments([
      {
        id: "reply",
        resourceKind: "artifact",
        resourceId: "same-time",
        anchor: { kind: "resource" },
        parentId: "root",
        authorId: "user-2",
        authorName: "Sam",
        content: "Reply",
        createdAt,
        reactions: [],
      },
      {
        id: "root",
        resourceKind: "artifact",
        resourceId: "same-time",
        anchor: { kind: "resource" },
        authorId: "user-1",
        authorName: "Maya",
        content: "Root",
        createdAt,
        reactions: [],
      },
    ])

    const comments = await listContextCommentsForResource("artifact", "same-time")
    expect(comments.map((comment) => comment.id)).toEqual(["root", "reply"])
  })

  it("rejects a reply whose parent no longer exists", async () => {
    await expect(
      replyToContextComment("missing", {
        authorId: "user-1",
        authorName: "Maya",
        content: "Reply",
      })
    ).rejects.toThrow(/not found/)
  })
})
