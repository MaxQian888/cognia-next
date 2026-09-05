import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import type { ContextComment } from "@/types/context-comment"
import { useChatStore } from "@/stores/chat"
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
      sendToChat: "Ask AI",
      sendToChatAria: "Add {author}'s comment to the next message",
      showResolved: "Show resolved",
      stale: "Outdated anchor",
      toggleReaction: "Toggle {emoji} reaction",
      you: "You",
    },
  },
}

function renderPanel(props: Partial<React.ComponentProps<typeof ContextCommentsPanel>> = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ContextCommentsPanel
        resource={{ kind: "workflow", id: "workflow-1" }}
        revision="r2"
        {...props}
      />
    </NextIntlClientProvider>
  )
}

describe("ContextCommentsPanel", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    comments = []
    useChatStore.getState().clearContextSelections()
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

  it("displays an anchor the host moved, without rewriting what was stored", () => {
    // The panel is resource-agnostic. A Canvas document with a live shared
    // document hands it a resolver backed by the CRDT, so a comment's line
    // range follows the text instead of naming where it used to be.
    comments = [
      {
        id: "comment-1",
        resourceKind: "workflow",
        resourceId: "workflow-1",
        anchor: { kind: "text-range", start: 6, end: 11, revision: "r2" },
        authorId: "user-1",
        authorName: "Maya",
        content: "look here",
        createdAt: new Date(),
        reactions: [],
      },
    ]
    const resolveAnchor = jest.fn(() => ({
      kind: "text-range" as const,
      start: 10,
      end: 15,
      revision: "r2",
      lineRange: { startLine: 4, startColumn: 1, endLine: 4, endColumn: 6 },
    }))

    renderPanel({ resolveAnchor })

    expect(resolveAnchor).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "text-range", start: 6, end: 11 })
    )
    // The stored row is untouched: a device that cannot resolve an anchor
    // still reads what was written.
    expect(comments[0].anchor).toMatchObject({ start: 6, end: 11 })
  })

  it("leaves anchors alone when the host has no way to move them", () => {
    comments = [
      {
        id: "comment-1",
        resourceKind: "workflow",
        resourceId: "workflow-1",
        anchor: { kind: "text-range", start: 6, end: 11, revision: "r2" },
        authorId: "user-1",
        authorName: "Maya",
        content: "look here",
        createdAt: new Date(),
        reactions: [],
      },
    ]
    renderPanel()
    expect(screen.getByText("look here")).toBeInTheDocument()
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

  // The panel had no route to the conversation at all: a user could write down
  // exactly what was wrong and the assistant would never see a word of it.
  describe("handing a comment to the chat", () => {
    const nodeComment: ContextComment = {
      id: "comment-1",
      resourceKind: "workflow",
      resourceId: "workflow-1",
      anchor: { kind: "workflow-node", nodeId: "node-1", revision: "r2" },
      authorId: "local-user",
      authorName: "You",
      content: "This branch never runs",
      createdAt: new Date(),
      reactions: [],
    }

    it("stages the comment as chat context, naming what it hangs off", () => {
      comments = [nodeComment]
      renderPanel({ resourceTitle: "Nightly sync" })

      fireEvent.click(screen.getByTestId("context-comment-to-chat"))

      expect(useChatStore.getState().contextSelections).toEqual([
        {
          kind: "comment",
          title: "Nightly sync",
          snapshot: "This branch never runs",
          comment: "",
          anchorLabel: "node node-1",
        },
      ])
    })

    it("falls back to the resource id when the host passes no title", () => {
      comments = [nodeComment]
      renderPanel()
      fireEvent.click(screen.getByTestId("context-comment-to-chat"))
      expect(useChatStore.getState().contextSelections[0]).toMatchObject({
        title: "workflow-1",
      })
    })

    // Raw character offsets mean nothing to the assistant, so a text range
    // reports its line numbers instead.
    it("prefers line numbers over character offsets for a text range", () => {
      comments = [
        {
          ...nodeComment,
          anchor: {
            kind: "text-range",
            start: 10,
            end: 40,
            lineRange: { startLine: 3, startColumn: 1, endLine: 9, endColumn: 12 },
          },
        },
      ]
      renderPanel()
      fireEvent.click(screen.getByTestId("context-comment-to-chat"))
      expect(useChatStore.getState().contextSelections[0]).toMatchObject({
        anchorLabel: "lines 3-9",
      })
    })

    // A comment on the whole resource has no sub-location worth naming.
    it("omits the anchor label for a whole-resource comment", () => {
      comments = [{ ...nodeComment, anchor: { kind: "resource", revision: "r2" } }]
      renderPanel()
      fireEvent.click(screen.getByTestId("context-comment-to-chat"))
      const [staged] = useChatStore.getState().contextSelections
      expect(staged.kind).toBe("comment")
      expect(staged.kind === "comment" && staged.anchorLabel).toBeUndefined()
    })
  })
})
