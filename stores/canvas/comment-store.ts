/**
 * Comment Store - Comments and annotations for Canvas documents
 */

import { create } from "zustand"
import { persist } from "zustand/middleware"
import { nanoid } from "nanoid"
import type { CanvasComment, LineRange } from "@/types/canvas/collaboration"
import { loggers } from "@/lib/logger"

interface CommentState {
  comments: Record<string, CanvasComment[]>
  activeThreadId: string | null

  addComment: (
    docId: string,
    comment: Omit<CanvasComment, "id" | "createdAt" | "reactions">
  ) => CanvasComment
  updateComment: (docId: string, commentId: string, content: string) => void
  deleteComment: (docId: string, commentId: string) => void
  resolveComment: (docId: string, commentId: string) => void
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

export const useCommentStore = create<CommentState>()(
  persist(
    (set, get) => ({
      comments: {},
      activeThreadId: null,

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
      },

      resolveComment: (docId, commentId) => {
        set((state) => ({
          comments: {
            ...state.comments,
            [docId]: (state.comments[docId] || []).map((c) =>
              c.id === commentId ? { ...c, resolvedAt: new Date() } : c
            ),
          },
        }))
      },

      unresolveComment: (docId, commentId) => {
        set((state) => ({
          comments: {
            ...state.comments,
            [docId]: (state.comments[docId] || []).map((c) =>
              c.id === commentId ? { ...c, resolvedAt: undefined } : c
            ),
          },
        }))
      },

      addReaction: (docId, commentId, emoji, userId) => {
        set((state) => ({
          comments: {
            ...state.comments,
            [docId]: (state.comments[docId] || []).map((c) => {
              if (c.id !== commentId) return c

              const reactions = [...c.reactions]
              const existingReaction = reactions.find((r) => r.emoji === emoji)

              if (existingReaction) {
                if (!existingReaction.users.includes(userId)) {
                  existingReaction.users.push(userId)
                }
              } else {
                reactions.push({ emoji, users: [userId] })
              }

              return { ...c, reactions }
            }),
          },
        }))
      },

      removeReaction: (docId, commentId, emoji, userId) => {
        set((state) => ({
          comments: {
            ...state.comments,
            [docId]: (state.comments[docId] || []).map((c) => {
              if (c.id !== commentId) return c

              const reactions = c.reactions
                .map((r) => {
                  if (r.emoji !== emoji) return r
                  return {
                    ...r,
                    users: r.users.filter((u) => u !== userId),
                  }
                })
                .filter((r) => r.users.length > 0)

              return { ...c, reactions }
            }),
          },
        }))
      },

      replyToComment: (docId, parentId, reply) => {
        const parentComment = get().comments[docId]?.find((c) => c.id === parentId)
        if (!parentComment) {
          throw new Error("Parent comment not found")
        }

        const newReply: CanvasComment = {
          ...reply,
          id: nanoid(),
          createdAt: new Date(),
          reactions: [],
          range: parentComment.range,
          parentId,
        }

        set((state) => ({
          comments: {
            ...state.comments,
            [docId]: [...(state.comments[docId] || []), newReply],
          },
        }))

        return newReply
      },

      getCommentsForDocument: (docId) => {
        return get().comments[docId] || []
      },

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

      setActiveThread: (threadId) => {
        set({ activeThreadId: threadId })
      },

      clearDocumentComments: (docId) => {
        set((state) => {
          const { [docId]: _, ...rest } = state.comments
          return { comments: rest }
        })
      },
    }),
    {
      name: "cognia-canvas-comments",
      partialize: (state) => ({
        comments: state.comments,
      }),
      storage: {
        getItem: (name) => {
          try {
            const raw = localStorage.getItem(name)
            if (!raw) return null
            const parsed = JSON.parse(raw)
            // Revive Date fields from ISO strings
            if (parsed?.state?.comments) {
              for (const docComments of Object.values(parsed.state.comments)) {
                if (Array.isArray(docComments)) {
                  for (const comment of docComments as Record<string, unknown>[]) {
                    if (typeof comment.createdAt === "string")
                      comment.createdAt = new Date(comment.createdAt)
                    if (typeof comment.updatedAt === "string")
                      comment.updatedAt = new Date(comment.updatedAt)
                    if (typeof comment.resolvedAt === "string")
                      comment.resolvedAt = new Date(comment.resolvedAt)
                  }
                }
              }
            }
            return parsed
          } catch (err) {
            loggers.canvas.warn("comment-store getItem failed", {
              name,
              error: String(err),
            })
            return null
          }
        },
        setItem: (name, value) => {
          try {
            localStorage.setItem(name, JSON.stringify(value))
          } catch (err) {
            loggers.canvas.warn("comment-store setItem failed", {
              name,
              error: String(err),
            })
          }
        },
        removeItem: (name) => localStorage.removeItem(name),
      },
    }
  )
)

export default useCommentStore
