import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import type { ContextComment } from "@/types/context-comment"
import { ContextCommentsPanel } from "./context-comments-panel"

let comments: ContextComment[] = []
const addContextComment = jest.fn(async (..._args: unknown[]) => undefined)
const replyToContextComment = jest.fn(async (..._args: unknown[]) => undefined)
const updateContextComment = jest.fn(async (..._args: unknown[]) => undefined)
const deleteContextComment = jest.fn(async (..._args: unknown[]) => undefined)
const resolveContextComment = jest.fn(async (..._args: unknown[]) => undefined)
const reopenContextComment = jest.fn(async (..._args: unknown[]) => undefined)
const addContextCommentReaction = jest.fn(async (..._args: unknown[]) => undefined)
const removeContextCommentReaction = jest.fn(async (..._args: unknown[]) => undefined)

jest.mock("dexie-react-hooks", () => ({ useLiveQuery: () => comments }))
jest.mock("@/lib/db/context-comments", () => ({
  addContextComment: (...args: unknown[]) => addContextComment(...args),
  replyToContextComment: (...args: unknown[]) => replyToContextComment(...args),
  updateContextComment: (...args: unknown[]) => updateContextComment(...args),
  deleteContextComment: (...args: unknown[]) => deleteContextComment(...args),
  resolveContextComment: (...args: unknown[]) => resolveContextComment(...args),
  reopenContextComment: (...args: unknown[]) => reopenContextComment(...args),
  addContextCommentReaction: (...args: unknown[]) => addContextCommentReaction(...args),
  removeContextCommentReaction: (...args: unknown[]) => removeContextCommentReaction(...args),
  listContextCommentsForResource: jest.fn(),
}))

const messages = {
  contextWorkbench: {
    commentsPanel: {
      add: "Add comment",
      cancel: "Cancel",
      delete: "Delete",
      edit: "Edit",
      empty: "No comments",
      hideResolved: "Hide resolved",
      placeholder: "Write a comment",
      reopen: "Reopen",
      reply: "Reply",
      replyPlaceholder: "Write a reply",
      resolve: "Resolve",
      resolved: "Resolved",
      save: "Save",
      showResolved: "Show resolved",
      stale: "Outdated anchor",
      toggleReaction: "Toggle {emoji} reaction",
      you: "You",
    },
  },
}

function renderPanel() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ContextCommentsPanel resource={{ kind: "workflow", id: "workflow-1" }} revision="r2" />
    </NextIntlClientProvider>
  )
}

describe("ContextCommentsPanel", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    comments = []
  })

  it("creates a revision-bound resource comment", () => {
    renderPanel()
    fireEvent.change(screen.getByRole("textbox", { name: "Write a comment" }), {
      target: { value: "Review this workflow" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Add comment" }))
    expect(addContextComment).toHaveBeenCalledWith(
      expect.objectContaining({
        resource: { kind: "workflow", id: "workflow-1" },
        anchor: { kind: "resource", revision: "r2" },
        content: "Review this workflow",
      })
    )
  })

  it("shows stale anchors and exposes reply, edit, reaction, resolve, and delete actions", () => {
    comments = [
      {
        id: "comment-1",
        resourceKind: "workflow",
        resourceId: "workflow-1",
        anchor: { kind: "workflow-node", nodeId: "node-1", revision: "r1" },
        authorId: "local-user",
        authorName: "You",
        content: "Check this node",
        createdAt: new Date(),
        reactions: [],
      },
    ]
    renderPanel()
    expect(screen.getByText("Outdated anchor")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Reply" }))
    expect(screen.getByRole("textbox", { name: "Write a reply" })).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Edit" }))
    fireEvent.click(screen.getByRole("button", { name: /Toggle 👍 reaction/ }))
    fireEvent.click(screen.getByRole("button", { name: "Resolve" }))
    fireEvent.click(screen.getByRole("button", { name: "Delete" }))
    expect(addContextCommentReaction).toHaveBeenCalledWith("comment-1", "👍", "local-user")
    expect(resolveContextComment).toHaveBeenCalledWith("comment-1", "local-user")
    expect(deleteContextComment).toHaveBeenCalledWith("comment-1")
  })
})
