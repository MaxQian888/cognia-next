/** @jest-environment jsdom */
/**
 * Tests for stores/canvas/comment-store — Dexie-backed reactive comment cache.
 *
 * Source of truth is `lib/db/canvas-comments` (Dexie). The store mirrors it
 * in memory so the UI can read synchronously; mutations are
 * optimistic-then-Dexie. Legacy localStorage payloads are migrated on first
 * import via `hydrateLegacyLocalStorage`.
 */

import "fake-indexeddb/auto"
import { act, renderHook } from "@testing-library/react"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import * as canvasCommentsDb from "@/lib/db/canvas-comments"
import { useCommentStore, hydrateLegacyLocalStorage, __TESTING__ } from "./comment-store"

const createRange = (startLine: number, endLine: number) => ({
  startLine,
  startColumn: 0,
  endLine,
  endColumn: 0,
})

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  localStorage.clear()
  // Reset the live store between tests; module is shared across the suite.
  useCommentStore.setState({
    comments: {},
    loadedDocs: new Set<string>(),
    activeThreadId: null,
  })
})

describe("addComment", () => {
  it("returns the new comment synchronously and writes it to Dexie", async () => {
    const { result } = renderHook(() => useCommentStore())
    let id = ""
    act(() => {
      const c = result.current.addComment("doc1", {
        content: "Test comment",
        documentId: "doc1",
        authorId: "user1",
        authorName: "User 1",
        range: createRange(1, 5),
      })
      id = c.id
    })
    expect(result.current.getCommentsForDocument("doc1")).toHaveLength(1)
    await Promise.resolve()
    await Promise.resolve()
    const persisted = await canvasCommentsDb.listForDocument("doc1")
    expect(persisted.find((c) => c.id === id)).toBeDefined()
  })

  it("assigns unique IDs across calls", () => {
    const { result } = renderHook(() => useCommentStore())
    act(() => {
      result.current.addComment("doc1", {
        content: "1",
        documentId: "doc1",
        authorId: "u",
        authorName: "U",
        range: createRange(1, 1),
      })
      result.current.addComment("doc1", {
        content: "2",
        documentId: "doc1",
        authorId: "u",
        authorName: "U",
        range: createRange(2, 2),
      })
    })
    const cs = result.current.getCommentsForDocument("doc1")
    expect(cs[0].id).not.toBe(cs[1].id)
  })
})

describe("updateComment", () => {
  it("mutates content and stamps updatedAt as Date", () => {
    const { result } = renderHook(() => useCommentStore())
    let id = ""
    act(() => {
      const c = result.current.addComment("doc1", {
        content: "Original",
        documentId: "doc1",
        authorId: "u",
        authorName: "U",
        range: createRange(1, 1),
      })
      id = c.id
    })
    act(() => {
      result.current.updateComment("doc1", id, "Updated")
    })
    const updated = result.current.getCommentsForDocument("doc1").find((c) => c.id === id)
    expect(updated?.content).toBe("Updated")
    expect(updated?.updatedAt).toBeInstanceOf(Date)
  })
})

describe("deleteComment", () => {
  it("removes the comment from in-memory state", () => {
    const { result } = renderHook(() => useCommentStore())
    let id = ""
    act(() => {
      const c = result.current.addComment("doc1", {
        content: "x",
        documentId: "doc1",
        authorId: "u",
        authorName: "U",
        range: createRange(1, 1),
      })
      id = c.id
    })
    act(() => {
      result.current.deleteComment("doc1", id)
    })
    expect(result.current.getCommentsForDocument("doc1")).toHaveLength(0)
  })

  it("cascades to replies referencing the deleted comment", () => {
    const { result } = renderHook(() => useCommentStore())
    let parentId = ""
    act(() => {
      const parent = result.current.addComment("doc1", {
        content: "parent",
        documentId: "doc1",
        authorId: "u",
        authorName: "U",
        range: createRange(1, 1),
      })
      parentId = parent.id
      result.current.replyToComment("doc1", parentId, {
        content: "reply",
        documentId: "doc1",
        authorId: "u2",
        authorName: "U2",
      })
    })
    expect(result.current.getCommentsForDocument("doc1")).toHaveLength(2)
    act(() => {
      result.current.deleteComment("doc1", parentId)
    })
    expect(result.current.getCommentsForDocument("doc1")).toEqual([])
  })

  it("is a no-op for an unknown document id", () => {
    const { result } = renderHook(() => useCommentStore())
    act(() => {
      result.current.deleteComment("missing-doc", "missing-comment")
    })
    expect(result.current.getCommentsForDocument("missing-doc")).toEqual([])
  })
})

describe("resolveComment / unresolveComment", () => {
  it("flips resolvedAt + resolvedBy then clears them", () => {
    const { result } = renderHook(() => useCommentStore())
    let id = ""
    act(() => {
      const c = result.current.addComment("doc1", {
        content: "Issue",
        documentId: "doc1",
        authorId: "u",
        authorName: "U",
        range: createRange(1, 1),
      })
      id = c.id
    })
    act(() => {
      result.current.resolveComment("doc1", id, "owner")
    })
    let target = result.current.getCommentsForDocument("doc1").find((c) => c.id === id)
    expect(target?.resolvedAt).toBeInstanceOf(Date)
    expect(target?.resolvedBy).toBe("owner")
    act(() => {
      result.current.unresolveComment("doc1", id)
    })
    target = result.current.getCommentsForDocument("doc1").find((c) => c.id === id)
    expect(target?.resolvedAt).toBeUndefined()
    expect(target?.resolvedBy).toBeUndefined()
  })

  it("resolveComment is a no-op for an unknown document", () => {
    const { result } = renderHook(() => useCommentStore())
    act(() => {
      result.current.resolveComment("nope", "x")
    })
    expect(result.current.getCommentsForDocument("nope")).toEqual([])
  })

  it("unresolveComment is a no-op for an unknown document", () => {
    const { result } = renderHook(() => useCommentStore())
    act(() => {
      result.current.unresolveComment("nope", "x")
    })
    expect(result.current.getCommentsForDocument("nope")).toEqual([])
  })
})

describe("addReaction / removeReaction", () => {
  function seedOne() {
    const { result } = renderHook(() => useCommentStore())
    let id = ""
    act(() => {
      const c = result.current.addComment("doc1", {
        content: "x",
        documentId: "doc1",
        authorId: "u",
        authorName: "U",
        range: createRange(1, 1),
      })
      id = c.id
    })
    return { result, id }
  }

  it("adds an emoji + user without duplicating same user/emoji", () => {
    const { result, id } = seedOne()
    act(() => {
      result.current.addReaction("doc1", id, "👍", "ua")
      result.current.addReaction("doc1", id, "👍", "ua")
      result.current.addReaction("doc1", id, "👍", "ub")
    })
    const c = result.current.getCommentsForDocument("doc1").find((x) => x.id === id)
    expect(c?.reactions).toEqual([{ emoji: "👍", users: ["ua", "ub"] }])
  })

  it("removeReaction prunes the reaction when no users remain", () => {
    const { result, id } = seedOne()
    act(() => {
      result.current.addReaction("doc1", id, "🎉", "ua")
      result.current.removeReaction("doc1", id, "🎉", "ua")
    })
    const c = result.current.getCommentsForDocument("doc1").find((x) => x.id === id)
    expect(c?.reactions).toEqual([])
  })

  it("removeReaction keeps other emoji reactions untouched", () => {
    const { result, id } = seedOne()
    act(() => {
      result.current.addReaction("doc1", id, "👍", "ua")
      result.current.addReaction("doc1", id, "🎉", "ua")
      result.current.removeReaction("doc1", id, "🎉", "ua")
    })
    const c = result.current.getCommentsForDocument("doc1").find((x) => x.id === id)
    expect(c?.reactions.map((r) => r.emoji)).toEqual(["👍"])
  })

  it("addReaction is a no-op for unknown document", () => {
    const { result } = renderHook(() => useCommentStore())
    act(() => {
      result.current.addReaction("nope", "x", "👍", "u")
    })
    expect(result.current.getCommentsForDocument("nope")).toEqual([])
  })

  it("removeReaction is a no-op for unknown document", () => {
    const { result } = renderHook(() => useCommentStore())
    act(() => {
      result.current.removeReaction("nope", "x", "👍", "u")
    })
    expect(result.current.getCommentsForDocument("nope")).toEqual([])
  })
})

describe("replyToComment", () => {
  it("inherits parent range and parentId", () => {
    const { result } = renderHook(() => useCommentStore())
    let parentId = ""
    act(() => {
      const p = result.current.addComment("doc1", {
        content: "parent",
        documentId: "doc1",
        authorId: "u",
        authorName: "U",
        range: createRange(3, 5),
      })
      parentId = p.id
    })
    let replyId = ""
    act(() => {
      const r = result.current.replyToComment("doc1", parentId, {
        content: "reply",
        documentId: "doc1",
        authorId: "u2",
        authorName: "U2",
      })
      replyId = r.id
    })
    const reply = result.current.getCommentsForDocument("doc1").find((c) => c.id === replyId)
    expect(reply?.parentId).toBe(parentId)
    expect(reply?.range).toEqual(createRange(3, 5))
  })

  it("throws when the parent comment cannot be located", () => {
    const { result } = renderHook(() => useCommentStore())
    expect(() => {
      result.current.replyToComment("doc1", "missing", {
        content: "reply",
        documentId: "doc1",
        authorId: "u",
        authorName: "U",
      })
    }).toThrow("Parent comment not found")
  })
})

describe("getCommentsInRange", () => {
  it("returns comments overlapping the queried range", () => {
    const { result } = renderHook(() => useCommentStore())
    act(() => {
      result.current.addComment("doc1", {
        content: "in",
        documentId: "doc1",
        authorId: "u",
        authorName: "U",
        range: createRange(3, 7),
      })
      result.current.addComment("doc1", {
        content: "out",
        documentId: "doc1",
        authorId: "u",
        authorName: "U",
        range: createRange(50, 60),
      })
    })
    const inRange = result.current.getCommentsInRange("doc1", createRange(1, 8))
    expect(inRange.map((c) => c.content)).toEqual(["in"])
  })

  it("returns [] for a never-seen document", () => {
    const { result } = renderHook(() => useCommentStore())
    expect(result.current.getCommentsInRange("none", createRange(1, 5))).toEqual([])
  })
})

describe("getUnresolvedComments", () => {
  it("excludes resolved comments and replies", () => {
    const { result } = renderHook(() => useCommentStore())
    let toResolve = ""
    let parentId = ""
    act(() => {
      result.current.addComment("doc1", {
        content: "open",
        documentId: "doc1",
        authorId: "u",
        authorName: "U",
        range: createRange(1, 1),
      })
      const r = result.current.addComment("doc1", {
        content: "closed",
        documentId: "doc1",
        authorId: "u",
        authorName: "U",
        range: createRange(2, 2),
      })
      toResolve = r.id
      const p = result.current.addComment("doc1", {
        content: "thread",
        documentId: "doc1",
        authorId: "u",
        authorName: "U",
        range: createRange(3, 3),
      })
      parentId = p.id
      result.current.replyToComment("doc1", parentId, {
        content: "reply",
        documentId: "doc1",
        authorId: "u",
        authorName: "U",
      })
    })
    act(() => {
      result.current.resolveComment("doc1", toResolve)
    })
    const unresolved = result.current.getUnresolvedComments("doc1")
    expect(unresolved.map((c) => c.content).sort()).toEqual(["open", "thread"])
  })

  it("returns [] for a never-seen document", () => {
    const { result } = renderHook(() => useCommentStore())
    expect(result.current.getUnresolvedComments("none")).toEqual([])
  })
})

describe("setActiveThread", () => {
  it("sets and clears the active thread id", () => {
    const { result } = renderHook(() => useCommentStore())
    act(() => {
      result.current.setActiveThread("t1")
    })
    expect(result.current.activeThreadId).toBe("t1")
    act(() => {
      result.current.setActiveThread(null)
    })
    expect(result.current.activeThreadId).toBeNull()
  })
})

describe("clearDocumentComments", () => {
  it("removes the in-memory entry for the doc", () => {
    const { result } = renderHook(() => useCommentStore())
    act(() => {
      result.current.addComment("doc1", {
        content: "x",
        documentId: "doc1",
        authorId: "u",
        authorName: "U",
        range: createRange(1, 1),
      })
    })
    expect(result.current.getCommentsForDocument("doc1")).toHaveLength(1)
    act(() => {
      result.current.clearDocumentComments("doc1")
    })
    expect(result.current.getCommentsForDocument("doc1")).toEqual([])
  })
})

describe("loadCommentsForDocument", () => {
  it("hydrates the in-memory cache from Dexie on first call; idempotent on second", async () => {
    await canvasCommentsDb.addComment({
      documentId: "doc1",
      authorId: "u",
      authorName: "U",
      range: createRange(1, 1),
      content: "from disk",
    })
    const { result } = renderHook(() => useCommentStore())
    expect(result.current.getCommentsForDocument("doc1")).toEqual([])
    await act(async () => {
      await result.current.loadCommentsForDocument("doc1")
    })
    const loaded = result.current.getCommentsForDocument("doc1")
    expect(loaded).toHaveLength(1)
    expect(loaded[0].content).toBe("from disk")
    await canvasCommentsDb.addComment({
      documentId: "doc1",
      authorId: "u",
      authorName: "U",
      range: createRange(2, 2),
      content: "added later",
    })
    await act(async () => {
      await result.current.loadCommentsForDocument("doc1")
    })
    expect(result.current.getCommentsForDocument("doc1")).toHaveLength(1)
  })

  it("recovers when Dexie throws (e.g. closed DB) without crashing the store", async () => {
    await getDb().close()
    const { result } = renderHook(() => useCommentStore())
    await act(async () => {
      await result.current.loadCommentsForDocument("any-doc")
    })
    expect(result.current.getCommentsForDocument("any-doc")).toEqual([])
  })
})

describe("Date serialization", () => {
  it("addComment stores createdAt as a Date", () => {
    const { result } = renderHook(() => useCommentStore())
    act(() => {
      result.current.addComment("doc1", {
        content: "x",
        documentId: "doc1",
        authorId: "u",
        authorName: "U",
        range: createRange(1, 1),
      })
    })
    const c = result.current.getCommentsForDocument("doc1")[0]
    expect(c.createdAt).toBeInstanceOf(Date)
  })
})

describe("hydrateLegacyLocalStorage", () => {
  const KEY = "cognia-canvas-comments"
  const FLAG = "cognia-canvas-comments-migrated-v1"

  it("imports legacy localStorage payload into Dexie and removes the key", async () => {
    const stored = JSON.stringify({
      state: {
        comments: {
          doc1: [
            {
              id: "legacy_1",
              documentId: "doc1",
              authorId: "u",
              authorName: "U",
              range: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 0 },
              content: "legacy",
              createdAt: "2025-01-01T00:00:00.000Z",
              reactions: [],
            },
          ],
        },
      },
      version: 0,
    })
    localStorage.setItem(KEY, stored)
    localStorage.removeItem(FLAG)
    const inserted = await hydrateLegacyLocalStorage()
    expect(inserted).toBe(1)
    expect(localStorage.getItem(KEY)).toBeNull()
    expect(localStorage.getItem(FLAG)).toBe("1")
    const persisted = await canvasCommentsDb.listForDocument("doc1")
    expect(persisted[0].content).toBe("legacy")
  })

  it("is idempotent — running twice with the flag set imports nothing", async () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        state: {
          comments: {
            d: [
              {
                id: "x",
                documentId: "d",
                authorId: "u",
                authorName: "U",
                range: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 0 },
                content: "x",
                createdAt: "2025-01-01T00:00:00.000Z",
                reactions: [],
              },
            ],
          },
        },
        version: 0,
      })
    )
    localStorage.removeItem(FLAG)
    expect(await hydrateLegacyLocalStorage()).toBe(1)
    expect(await hydrateLegacyLocalStorage()).toBe(0)
  })

  it("sets the migration flag even when no legacy payload exists", async () => {
    localStorage.removeItem(KEY)
    localStorage.removeItem(FLAG)
    expect(await hydrateLegacyLocalStorage()).toBe(0)
    expect(localStorage.getItem(FLAG)).toBe("1")
  })

  it("returns 0 and recovers when the legacy payload is malformed JSON", async () => {
    localStorage.setItem(KEY, "not-json")
    localStorage.removeItem(FLAG)
    expect(await hydrateLegacyLocalStorage()).toBe(0)
  })

  it("skips comments missing required string fields", async () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        state: {
          comments: {
            d: [
              { id: 123, documentId: "d", content: "skip" },
              {
                id: "ok",
                documentId: "d",
                authorId: "u",
                authorName: "U",
                range: { startLine: 1, startColumn: 0, endLine: 1, endColumn: 0 },
                content: "ok",
                createdAt: "2025-01-01T00:00:00.000Z",
                reactions: [],
              },
            ],
          },
        },
        version: 0,
      })
    )
    localStorage.removeItem(FLAG)
    expect(await hydrateLegacyLocalStorage()).toBe(1)
  })

  it("ignores non-array doc entries gracefully", async () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        state: { comments: { d: "not an array" } },
        version: 0,
      })
    )
    localStorage.removeItem(FLAG)
    expect(await hydrateLegacyLocalStorage()).toBe(0)
  })

  it("revives a legacy payload with mostly-missing optional fields by filling defaults", async () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        state: {
          comments: {
            d: [
              {
                id: "minimal",
                documentId: "d",
                authorId: 99,
                authorName: null,
                content: false,
                resolvedBy: 1,
                parentId: 0,
                authorAvatarUrl: 7,
                reactions: "not-an-array",
                createdAt: "not-a-date",
                updatedAt: 12345,
                resolvedAt: { not: "a date" },
              },
            ],
          },
        },
        version: 0,
      })
    )
    localStorage.removeItem(FLAG)
    expect(await hydrateLegacyLocalStorage()).toBe(1)
    const persisted = await canvasCommentsDb.listForDocument("d")
    expect(persisted[0].authorId).toBe("")
    expect(persisted[0].authorName).toBe("")
    expect(persisted[0].content).toBe("")
    expect(persisted[0].reactions).toEqual([])
    expect(persisted[0].parentId).toBeUndefined()
    expect(persisted[0].resolvedBy).toBeUndefined()
    expect(persisted[0].authorAvatarUrl).toBeUndefined()
    expect(persisted[0].createdAt).toBeInstanceOf(Date)
    expect(persisted[0].updatedAt).toBeInstanceOf(Date)
    expect(persisted[0].resolvedAt).toBeUndefined()
  })

  it("preserves a Date-instance createdAt verbatim through revive", () => {
    const revived = __TESTING__.reviveLegacyComment({
      id: "x",
      documentId: "d",
      createdAt: new Date(42_000),
    })
    expect(revived?.createdAt.getTime()).toBe(42_000)
  })

  it("returns null for entries missing the required string id", () => {
    expect(__TESTING__.reviveLegacyComment({ id: 123, documentId: "d" })).toBeNull()
  })

  it("falls back to a default range for legacy comments missing the range object", async () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        state: {
          comments: {
            d: [
              {
                id: "no-range",
                documentId: "d",
                authorId: "u",
                authorName: "U",
                content: "no range",
                createdAt: "2025-01-01T00:00:00.000Z",
                reactions: [],
              },
            ],
          },
        },
        version: 0,
      })
    )
    localStorage.removeItem(FLAG)
    expect(await hydrateLegacyLocalStorage()).toBe(1)
    const persisted = await canvasCommentsDb.listForDocument("d")
    expect(persisted[0].range).toEqual({ startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 })
  })
})

describe("multi-comment branch coverage", () => {
  function seedTwo() {
    const { result } = renderHook(() => useCommentStore())
    let aId = ""
    let bId = ""
    act(() => {
      const a = result.current.addComment("doc1", {
        content: "a",
        documentId: "doc1",
        authorId: "u",
        authorName: "U",
        range: createRange(1, 1),
      })
      const b = result.current.addComment("doc1", {
        content: "b",
        documentId: "doc1",
        authorId: "u",
        authorName: "U",
        range: createRange(2, 2),
      })
      aId = a.id
      bId = b.id
    })
    return { result, aId, bId }
  }

  it("updateComment touches only the matching id", () => {
    const { result, aId, bId } = seedTwo()
    act(() => {
      result.current.updateComment("doc1", aId, "edited")
    })
    const cs = result.current.getCommentsForDocument("doc1")
    expect(cs.find((c) => c.id === aId)?.content).toBe("edited")
    expect(cs.find((c) => c.id === bId)?.content).toBe("b")
  })

  it("unresolveComment touches only the matching id", () => {
    const { result, aId, bId } = seedTwo()
    act(() => {
      result.current.resolveComment("doc1", aId)
      result.current.resolveComment("doc1", bId)
      result.current.unresolveComment("doc1", aId)
    })
    const cs = result.current.getCommentsForDocument("doc1")
    expect(cs.find((c) => c.id === aId)?.resolvedAt).toBeUndefined()
    expect(cs.find((c) => c.id === bId)?.resolvedAt).toBeInstanceOf(Date)
  })

  it("addReaction / removeReaction skip non-matching comments", () => {
    const { result, aId, bId } = seedTwo()
    act(() => {
      result.current.addReaction("doc1", aId, "👍", "ua")
      result.current.removeReaction("doc1", aId, "👍", "ua")
    })
    const cs = result.current.getCommentsForDocument("doc1")
    expect(cs.find((c) => c.id === aId)?.reactions).toEqual([])
    expect(cs.find((c) => c.id === bId)?.reactions).toEqual([])
  })

  it("replyToComment appends to an already-populated doc list", () => {
    const { result, aId } = seedTwo()
    act(() => {
      result.current.replyToComment("doc1", aId, {
        content: "reply-to-a",
        documentId: "doc1",
        authorId: "u2",
        authorName: "U2",
      })
    })
    expect(result.current.getCommentsForDocument("doc1")).toHaveLength(3)
  })

  it("getCommentsInRange skips comments whose range field is missing", () => {
    useCommentStore.setState({
      comments: {
        doc1: [
          {
            id: "no-range",
            documentId: "doc1",
            authorId: "u",
            authorName: "U",
            content: "x",
            createdAt: new Date(),
            reactions: [],
            range: undefined as unknown as ReturnType<typeof createRange>,
          },
        ],
      },
      loadedDocs: new Set(["doc1"]),
      activeThreadId: null,
    })
    const { result } = renderHook(() => useCommentStore())
    expect(result.current.getCommentsInRange("doc1", createRange(1, 5))).toEqual([])
  })
})

describe("safeDexieCall failure path", () => {
  it("logs but does not throw when a fire-and-forget Dexie write fails", async () => {
    await getDb().close()
    const { result } = renderHook(() => useCommentStore())
    expect(() => {
      act(() => {
        result.current.addComment("doc1", {
          content: "x",
          documentId: "doc1",
          authorId: "u",
          authorName: "U",
          range: createRange(1, 1),
        })
      })
    }).not.toThrow()
    expect(result.current.getCommentsForDocument("doc1")).toHaveLength(1)
    await Promise.resolve()
    await Promise.resolve()
  })
})
