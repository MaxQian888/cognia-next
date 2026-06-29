import type { Meta, StoryObj } from "@storybook/nextjs"

import { CommentPanel } from "./comment-panel"
import { resetStore, seedStore } from "@/lib/storybook/seed-stores"
import { useCommentStore } from "@/stores/canvas/comment-store"
import { makeCanvasComment } from "@/lib/storybook/fixtures/canvas"

// CommentPanel renders a trigger button (with an unresolved-count badge) that
// opens a Sheet of threaded comments with replies, reactions, and resolve
// toggles. Comments live in `useCommentStore`; seeding `loadedDocs` short-
// circuits the Dexie load effect so the seeded rows render deterministically.
const documentId = "doc-1"

const meta = {
  title: "Canvas/CommentPanel",
  component: CommentPanel,
  parameters: { layout: "centered" },
  beforeEach: () => {
    resetStore(useCommentStore)
  },
  args: {
    documentId,
    currentUserId: "user-1",
    currentUserName: "You",
    selectedRange: { startLine: 1, startColumn: 1, endLine: 3, endColumn: 1 },
  },
} satisfies Meta<typeof CommentPanel>

export default meta
type Story = StoryObj<typeof meta>

// A thread with a reply, a reaction, and an unresolved root → badge shows count.
export const WithComments: Story = {
  beforeEach: () => {
    seedStore(useCommentStore, {
      comments: {
        [documentId]: [
          makeCanvasComment({ id: "c1", documentId, authorName: "Ada Lovelace" }),
          makeCanvasComment({
            id: "c2",
            documentId,
            authorId: "user-1",
            authorName: "You",
            content: "Agreed — I'll take a pass.",
            parentId: "c1",
          }),
          makeCanvasComment({
            id: "c3",
            documentId,
            authorName: "Grace Hopper",
            content: "Already handled in the last commit.",
            resolvedAt: new Date(Date.UTC(2026, 5, 20, 12, 0, 0)),
            resolvedBy: "Grace Hopper",
            reactions: [{ emoji: "👍", users: ["user-1"] }],
          }),
        ],
      },
      loadedDocs: new Set([documentId]),
    })
  },
}

// No comments yet → trigger has no badge; the Sheet shows the empty state.
export const NoComments: Story = {
  beforeEach: () => {
    seedStore(useCommentStore, {
      comments: { [documentId]: [] },
      loadedDocs: new Set([documentId]),
    })
  },
}
