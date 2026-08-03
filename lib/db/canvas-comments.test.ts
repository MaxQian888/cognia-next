/**
 * Tests for lib/db/canvas-comments.ts (schema v11+ canvasComments table).
 */

import {
  addComment,
  bulkImport,
  clearForDocument,
  deleteComment,
  listAll,
  listForDocument,
  listInRange,
  listUnresolved,
  removeReaction,
  addReaction,
  replyToComment,
  resolveComment,
  unresolveComment,
  updateComment,
  __TESTING__,
} from "./canvas-comments"
import type { CanvasComment, LineRange } from "@/types/canvas/collaboration"
import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

const RANGE: LineRange = { startLine: 1, startColumn: 1, endLine: 1, endColumn: 10 }

function makeDraft(overrides: Partial<CanvasComment> = {}) {
  return {
    documentId: overrides.documentId ?? "doc_1",
    authorId: overrides.authorId ?? "user_1",
    authorName: overrides.authorName ?? "Maya",
    authorAvatarUrl: overrides.authorAvatarUrl,
    range: overrides.range ?? RANGE,
    content: overrides.content ?? "Looks good",
    parentId: overrides.parentId,
  }
}

describe("canvas-comments CRUD", () => {
  it("addComment writes a row with id, createdAt, empty reactions", async () => {
    const c = await addComment(makeDraft())
    expect(c.id).toBeDefined()
    expect(c.createdAt).toBeInstanceOf(Date)
    expect(c.reactions).toEqual([])
    const persisted = await getDb().contextComments.get(c.id)
    expect(persisted?.resourceId).toBe("doc_1")
  })

  it("listForDocument returns oldest-first", async () => {
    const a = await addComment(makeDraft({ content: "first" }))
    await new Promise((r) => setTimeout(r, 2))
    const b = await addComment(makeDraft({ content: "second" }))
    const rows = await listForDocument("doc_1")
    expect(rows.map((r) => r.id)).toEqual([a.id, b.id])
  })

  it("listForDocument scopes by documentId", async () => {
    await addComment(makeDraft({ documentId: "doc_1" }))
    await addComment(makeDraft({ documentId: "doc_2" }))
    const rows = await listForDocument("doc_1")
    expect(rows).toHaveLength(1)
    expect(rows[0].documentId).toBe("doc_1")
  })

  it("listInRange filters by overlapping line range", async () => {
    await addComment(
      makeDraft({ range: { startLine: 1, startColumn: 1, endLine: 5, endColumn: 1 } })
    )
    await addComment(
      makeDraft({ range: { startLine: 100, startColumn: 1, endLine: 110, endColumn: 1 } })
    )
    const rows = await listInRange("doc_1", {
      startLine: 3,
      startColumn: 1,
      endLine: 7,
      endColumn: 1,
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].range.startLine).toBe(1)
  })

  it("listUnresolved excludes resolved and replies", async () => {
    const open = await addComment(makeDraft({ content: "open" }))
    const closed = await addComment(makeDraft({ content: "closed" }))
    await resolveComment(closed.id)
    await replyToComment(open.id, {
      authorId: "u2",
      authorName: "Sam",
      content: "+1",
    })
    const rows = await listUnresolved("doc_1")
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(open.id)
  })

  it("updateComment changes content and stamps updatedAt", async () => {
    const c = await addComment(makeDraft())
    await updateComment(c.id, "edited")
    const reloaded = (await listForDocument("doc_1"))[0]
    expect(reloaded.content).toBe("edited")
    expect(reloaded.updatedAt).toBeInstanceOf(Date)
  })

  it("deleteComment removes the comment AND its replies", async () => {
    const root = await addComment(makeDraft())
    await replyToComment(root.id, { authorId: "u2", authorName: "Sam", content: "reply" })
    await replyToComment(root.id, { authorId: "u3", authorName: "Tia", content: "reply2" })
    await deleteComment(root.id)
    expect(await listForDocument("doc_1")).toHaveLength(0)
  })

  it("resolveComment sets resolvedAt + resolvedBy; unresolveComment clears them", async () => {
    const c = await addComment(makeDraft())
    await resolveComment(c.id, "user_owner")
    let reloaded = (await listForDocument("doc_1"))[0]
    expect(reloaded.resolvedAt).toBeInstanceOf(Date)
    expect(reloaded.resolvedBy).toBe("user_owner")
    await unresolveComment(c.id)
    reloaded = (await listForDocument("doc_1"))[0]
    expect(reloaded.resolvedAt).toBeUndefined()
    expect(reloaded.resolvedBy).toBeUndefined()
  })

  it("addReaction adds emoji + user; idempotent for same user/emoji", async () => {
    const c = await addComment(makeDraft())
    await addReaction(c.id, "+1", "user_a")
    await addReaction(c.id, "+1", "user_a")
    await addReaction(c.id, "+1", "user_b")
    const reloaded = (await listForDocument("doc_1"))[0]
    expect(reloaded.reactions).toEqual([{ emoji: "+1", users: ["user_a", "user_b"] }])
  })

  it("removeReaction drops the user; emoji entry is cleared when no users left", async () => {
    const c = await addComment(makeDraft())
    await addReaction(c.id, "+1", "user_a")
    await addReaction(c.id, "+1", "user_b")
    await removeReaction(c.id, "+1", "user_a")
    let reloaded = (await listForDocument("doc_1"))[0]
    expect(reloaded.reactions[0].users).toEqual(["user_b"])
    await removeReaction(c.id, "+1", "user_b")
    reloaded = (await listForDocument("doc_1"))[0]
    expect(reloaded.reactions).toEqual([])
  })

  it("addReaction is a no-op when the comment is missing", async () => {
    await addReaction("missing_id", "+1", "user_a")
    expect(await getDb().contextComments.count()).toBe(0)
  })

  it("removeReaction is a no-op when the comment is missing", async () => {
    await removeReaction("missing_id", "+1", "user_a")
    expect(await getDb().contextComments.count()).toBe(0)
  })

  it("replyToComment inherits range, sets parentId, throws if parent missing", async () => {
    const root = await addComment(makeDraft())
    const reply = await replyToComment(root.id, {
      authorId: "u2",
      authorName: "Sam",
      content: "reply",
    })
    expect(reply.parentId).toBe(root.id)
    expect(reply.range).toEqual(RANGE)
    await expect(
      replyToComment("nonexistent", { authorId: "u2", authorName: "Sam", content: "x" })
    ).rejects.toThrow(/not found/)
  })

  it("clearForDocument cascades", async () => {
    await addComment(makeDraft({ documentId: "doc_1" }))
    await addComment(makeDraft({ documentId: "doc_1" }))
    await addComment(makeDraft({ documentId: "doc_2" }))
    await clearForDocument("doc_1")
    expect(await listForDocument("doc_1")).toHaveLength(0)
    expect(await listForDocument("doc_2")).toHaveLength(1)
  })

  it("bulkImport inserts new rows; skips existing ids; returns count", async () => {
    const seed: CanvasComment = {
      ...makeDraft(),
      id: "seed_1",
      createdAt: new Date(1000),
      reactions: [],
    }
    expect(await bulkImport([seed])).toBe(1)
    expect(await bulkImport([seed])).toBe(0)
    expect(await bulkImport([])).toBe(0)
  })

  it("listAll returns every comment regardless of document", async () => {
    await addComment(makeDraft({ documentId: "d1" }))
    await addComment(makeDraft({ documentId: "d2" }))
    expect(await listAll()).toHaveLength(2)
  })

  it("toRow / fromRow round-trip preserves Date instances", () => {
    const original: CanvasComment = {
      ...makeDraft(),
      id: "c1",
      createdAt: new Date(1000),
      updatedAt: new Date(2000),
      resolvedAt: new Date(3000),
      reactions: [{ emoji: "+1", users: ["u"] }],
    }
    const row = __TESTING__.toRow(original)
    expect(row.createdAt).toBe(1000)
    expect(row.updatedAt).toBe(2000)
    expect(row.resolvedAt).toBe(3000)
    const round = __TESTING__.fromRow(row)
    expect(round.createdAt.getTime()).toBe(1000)
    expect(round.updatedAt?.getTime()).toBe(2000)
    expect(round.resolvedAt?.getTime()).toBe(3000)
  })
})
