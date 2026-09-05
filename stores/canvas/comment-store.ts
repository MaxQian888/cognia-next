/**
 * Comment Store — comments and annotations for Canvas documents.
 *
 * Source of truth is Dexie (`canvasComments` table). This store is the
 * reactive in-memory mirror so the UI can read synchronously. Mutations:
 *  1. update in-memory state synchronously (optimistic + immediate render),
 *  2. fire-and-forget the matching Dexie write through `lib/db/canvas-comments`.
 *
 * Bring documents into memory via `loadCommentsForDocument(docId)`. The
 * legacy localStorage cache (Zustand `persist` v0) is migrated into Dexie on
 * first import and the key is removed.
 */

import { create } from "zustand"
import { nanoid } from "nanoid"
import type { CanvasComment, LineRange } from "@/types/canvas/collaboration"
import * as canvasCommentsDb from "@/lib/db/canvas-comments"
import { registerCanvasDocumentDisposer } from "@/lib/canvas/document-disposal"
import { loggers } from "@cognia/logging"

interface CommentState {
  comments: Record<string, CanvasComment[]>
  loadedDocs: Set<string>
  activeThreadId: string | null

  /** Pull a document's comments out of Dexie into memory. Idempotent. */
  loadCommentsForDocument: (docId: string) => Promise<void>

  addComment: (
    docId: string,
    comment: Omit<CanvasComment, "id" | "createdAt" | "reactions">
  ) => CanvasComment
  updateComment: (docId: string, commentId: string, content: string) => void
  deleteComment: (docId: string, commentId: string) => void
  resolveComment: (docId: string, commentId: string, resolvedBy?: string) => void
  unresolveComment: (docId: string, commentId: string) => void
  addReaction: (docId: string, commentId: string, emoji: string, userId: string) => void
  removeReaction: (docId: string, commentId: string, emoji: string, userId: string) => void
  replyToComment: (
    docId: string,
    parentId: string,
    reply: Omit<CanvasComment, "id" | "createdAt" | "reactions" | "range" | "parentId">
  ) => CanvasComment
  getCommentsForDocument: (docId: string) => CanvasComment[]
  getCommentsInRange: (docId: string, range: LineRange) => CanvasComment[]
  getUnresolvedComments: (docId: string) => CanvasComment[]
  setActiveThread: (threadId: string | null) => void
  clearDocumentComments: (docId: string) => void
}

const LEGACY_KEY = "cognia-canvas-comments"
const LEGACY_MIGRATED_KEY = "cognia-canvas-comments-migrated-v1"

function safeDexieCall<T>(label: string, fn: () => Promise<T>): void {
  fn().catch((err) => {
    loggers.canvas.warn(`comment-store ${label} failed`, { error: String(err) })
  })
}

export const useCommentStore = create<CommentState>()((set, get) => ({
  comments: {},
  loadedDocs: new Set<string>(),
  activeThreadId: null,

  loadCommentsForDocument: async (docId) => {
    if (get().loadedDocs.has(docId)) return
    try {
      const rows = await canvasCommentsDb.listForDocument(docId)
      set((state) => ({
        comments: { ...state.comments, [docId]: rows },
        loadedDocs: new Set(state.loadedDocs).add(docId),
      }))
    } catch (err) {
      loggers.canvas.warn("comment-store loadCommentsForDocument failed", {
        docId,
        error: String(err),
      })
    }
  },

  addComment: (docId, comment) => {
    const newComment: CanvasComment = {
      ...comment,
      id: nanoid(),
      createdAt: new Date(),
      reactions: [],
    }

    set((state) => ({
      comments: {
        ...state.comments,
        [docId]: [...(state.comments[docId] || []), newComment],
      },
    }))

    safeDexieCall("addComment", () =>
      canvasCommentsDb.bulkImport([newComment]).then(() => undefined)
    )

    return newComment
  },

  updateComment: (docId, commentId, content) => {
    set((state) => ({
      comments: {
        ...state.comments,
        [docId]: (state.comments[docId] || []).map((c) =>
          c.id === commentId ? { ...c, content, updatedAt: new Date() } : c
        ),
      },
    }))
    safeDexieCall("updateComment", () => canvasCommentsDb.updateComment(commentId, content))
  },

  deleteComment: (docId, commentId) => {
    set((state) => ({
      comments: {
        ...state.comments,
        [docId]: (state.comments[docId] || []).filter(
          (c) => c.id !== commentId && c.parentId !== commentId
        ),
      },
    }))
    safeDexieCall("deleteComment", () => canvasCommentsDb.deleteComment(commentId))
  },

  resolveComment: (docId, commentId, resolvedBy) => {
    set((state) => ({
      comments: {
        ...state.comments,
        [docId]: (state.comments[docId] || []).map((c) =>
          c.id === commentId ? { ...c, resolvedAt: new Date(), resolvedBy } : c
        ),
      },
    }))
    safeDexieCall("resolveComment", () => canvasCommentsDb.resolveComment(commentId, resolvedBy))
  },

  unresolveComment: (docId, commentId) => {
    set((state) => ({
      comments: {
        ...state.comments,
        [docId]: (state.comments[docId] || []).map((c) =>
          c.id === commentId ? { ...c, resolvedAt: undefined, resolvedBy: undefined } : c
        ),
      },
    }))
    safeDexieCall("unresolveComment", () => canvasCommentsDb.unresolveComment(commentId))
  },

  addReaction: (docId, commentId, emoji, userId) => {
    set((state) => ({
      comments: {
        ...state.comments,
        [docId]: (state.comments[docId] || []).map((c) => {
          if (c.id !== commentId) return c
          const reactions = [...c.reactions]
          const existing = reactions.find((r) => r.emoji === emoji)
          if (existing) {
            if (!existing.users.includes(userId)) existing.users.push(userId)
          } else {
            reactions.push({ emoji, users: [userId] })
          }
          return { ...c, reactions }
        }),
      },
    }))
    safeDexieCall("addReaction", () => canvasCommentsDb.addReaction(commentId, emoji, userId))
  },

  removeReaction: (docId, commentId, emoji, userId) => {
    set((state) => ({
      comments: {
        ...state.comments,
        [docId]: (state.comments[docId] || []).map((c) => {
          if (c.id !== commentId) return c
          const reactions = c.reactions
            .map((r) =>
              r.emoji === emoji ? { ...r, users: r.users.filter((u) => u !== userId) } : r
            )
            .filter((r) => r.users.length > 0)
          return { ...c, reactions }
        }),
      },
    }))
    safeDexieCall("removeReaction", () => canvasCommentsDb.removeReaction(commentId, emoji, userId))
  },

  replyToComment: (docId, parentId, reply) => {
    const parent = get().comments[docId]?.find((c) => c.id === parentId)
    if (!parent) {
      throw new Error("Parent comment not found")
    }
    const newReply: CanvasComment = {
      ...reply,
      id: nanoid(),
      createdAt: new Date(),
      reactions: [],
      range: parent.range,
      parentId,
    }
    set((state) => ({
      comments: {
        ...state.comments,
        [docId]: [...(state.comments[docId] || []), newReply],
      },
    }))
    safeDexieCall("replyToComment", () =>
      canvasCommentsDb.bulkImport([newReply]).then(() => undefined)
    )
    return newReply
  },

  getCommentsForDocument: (docId) => get().comments[docId] || [],

  getCommentsInRange: (docId, range) => {
    const comments = get().comments[docId] || []
    return comments.filter((c) => {
      if (!c.range) return false
      return c.range.startLine <= range.endLine && c.range.endLine >= range.startLine
    })
  },

  getUnresolvedComments: (docId) => {
    const comments = get().comments[docId] || []
    return comments.filter((c) => !c.resolvedAt && !c.parentId)
  },

  setActiveThread: (threadId) => set({ activeThreadId: threadId }),

  clearDocumentComments: (docId) => {
    set((state) => {
      const { [docId]: _removed, ...rest } = state.comments
      const nextLoaded = new Set(state.loadedDocs)
      nextLoaded.delete(docId)
      return { comments: rest, loadedDocs: nextLoaded }
    })
    safeDexieCall("clearForDocument", () => canvasCommentsDb.clearForDocument(docId))
  },
}))

/**
 * One-shot legacy migration. The pre-Dexie store persisted comments to
 * `localStorage["cognia-canvas-comments"]` via Zustand `persist`. Pull any
 * surviving payload into Dexie, then drop the key. A separate guard key
 * makes this idempotent across restarts even if the legacy key is restored
 * from a backup.
 */
export async function hydrateLegacyLocalStorage(): Promise<number> {
  if (typeof localStorage === "undefined") return 0
  try {
    if (localStorage.getItem(LEGACY_MIGRATED_KEY)) return 0
    const raw = localStorage.getItem(LEGACY_KEY)
    if (!raw) {
      localStorage.setItem(LEGACY_MIGRATED_KEY, "1")
      return 0
    }
    const parsed = JSON.parse(raw) as { state?: { comments?: Record<string, unknown[]> } }
    const grouped = parsed?.state?.comments ?? {}
    const all: CanvasComment[] = []
    for (const docComments of Object.values(grouped)) {
      if (!Array.isArray(docComments)) continue
      for (const raw of docComments as Record<string, unknown>[]) {
        const c = reviveLegacyComment(raw)
        if (c) all.push(c)
      }
    }
    let inserted = 0
    if (all.length > 0) {
      inserted = await canvasCommentsDb.bulkImport(all)
    }
    localStorage.setItem(LEGACY_MIGRATED_KEY, "1")
    localStorage.removeItem(LEGACY_KEY)
    return inserted
  } catch (err) {
    loggers.canvas.warn("comment-store hydrateLegacyLocalStorage failed", {
      error: String(err),
    })
    return 0
  }
}

function reviveLegacyComment(raw: Record<string, unknown>): CanvasComment | null {
  if (typeof raw.id !== "string" || typeof raw.documentId !== "string") return null
  const reviveDate = (v: unknown): Date | undefined => {
    if (v instanceof Date) return v
    if (typeof v === "string" || typeof v === "number") {
      const d = new Date(v)
      return Number.isNaN(d.getTime()) ? undefined : d
    }
    return undefined
  }
  return {
    id: raw.id,
    documentId: raw.documentId,
    authorId: typeof raw.authorId === "string" ? raw.authorId : "",
    authorName: typeof raw.authorName === "string" ? raw.authorName : "",
    authorAvatarUrl: typeof raw.authorAvatarUrl === "string" ? raw.authorAvatarUrl : undefined,
    content: typeof raw.content === "string" ? raw.content : "",
    range:
      raw.range && typeof raw.range === "object"
        ? (raw.range as LineRange)
        : { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 },
    createdAt: reviveDate(raw.createdAt) ?? new Date(),
    updatedAt: reviveDate(raw.updatedAt),
    resolvedAt: reviveDate(raw.resolvedAt),
    resolvedBy: typeof raw.resolvedBy === "string" ? raw.resolvedBy : undefined,
    reactions: Array.isArray(raw.reactions) ? (raw.reactions as CanvasComment["reactions"]) : [],
    parentId: typeof raw.parentId === "string" ? raw.parentId : undefined,
  }
}

// Fire the migration on first import. Guarded with try/catch inside
// hydrateLegacyLocalStorage so a missing localStorage / Dexie / fake-indexeddb
// instance never crashes module init.
if (typeof window !== "undefined") {
  void hydrateLegacyLocalStorage()
}

export const __TESTING__ = { LEGACY_KEY, LEGACY_MIGRATED_KEY, reviveLegacyComment }

export default useCommentStore

// A deleted document's threads must not survive it in memory. Registered here
// rather than imported by the artifact store, so deleting a document does not
// require every consumer of that store to load this one (and run the legacy
// localStorage migration below). `lib/canvas/dexie-bridge.ts` already imports
// this module at boot, which is what guarantees the disposer is registered by
// the time a delete can happen.
registerCanvasDocumentDisposer("canvas-comments", (documentId) => {
  useCommentStore.getState().clearDocumentComments(documentId)
})
