/**
 * @jest-environment jsdom
 *
 * Coverage for TaskComments:
 *   - empty state
 *   - renders an existing comment thread + attachment chips
 *   - operator can add a comment (store action + clear + toast); blank is a no-op
 *   - ⌘/Ctrl+Enter submits
 *   - link attachments open in a new tab; file/artifact chips copy the ref
 */

import React from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TaskComments } from "./task-comments"
import type { AgentTaskComment } from "@/types/agent/agent-team"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// Avoid the react-markdown ESM stack — render content verbatim.
jest.mock("@/components/chat/markdown-renderer", () => ({
  MarkdownRenderer: ({ content }: { content: string }) => (
    <div data-testid="mock-markdown">{content}</div>
  ),
}))

const addTaskCommentMock = jest.fn((input: { text: string }) => ({ id: "new", ...input }))
let storeTasks: Record<string, unknown> = {}
jest.mock("@/stores/agent/agent-team-store", () => ({
  useAgentTeamStore: (selector: (s: unknown) => unknown) =>
    selector({ tasks: storeTasks, addTaskComment: addTaskCommentMock }),
}))

const copyMock = jest.fn(async () => true)
jest.mock("@/hooks/ui/use-copy", () => ({
  useCopy: () => ({ copied: false, copy: copyMock }),
}))

const toastSuccess = jest.fn()
jest.mock("sonner", () => ({
  toast: { success: (...a: unknown[]) => toastSuccess(...a), error: jest.fn() },
}))

function makeComment(over: Partial<AgentTaskComment> = {}): AgentTaskComment {
  return {
    id: "c1",
    taskId: "t1",
    authorId: "tm-a",
    authorName: "Ada",
    text: "Found the bug",
    createdAt: new Date("2026-06-29T10:00:00Z"),
    ...over,
  }
}

beforeEach(() => {
  storeTasks = {}
  addTaskCommentMock.mockClear()
  copyMock.mockClear()
  toastSuccess.mockClear()
})

describe("TaskComments", () => {
  it("renders the empty state when there are no comments", () => {
    storeTasks = { t1: { id: "t1", comments: [] } }
    render(<TaskComments taskId="t1" />)
    expect(screen.getByText("empty")).toBeInTheDocument()
  })

  it("renders an existing comment with author, body, and attachment chips", () => {
    storeTasks = {
      t1: {
        id: "t1",
        comments: [
          makeComment({
            attachments: [
              { id: "a1", name: "patch.diff", kind: "file", ref: "fix/patch.diff" },
              { id: "a2", name: "spec", kind: "link", ref: "https://example.com/spec" },
            ],
          }),
        ],
      },
    }
    render(<TaskComments taskId="t1" />)
    expect(screen.getByText("Ada")).toBeInTheDocument()
    expect(screen.getByTestId("mock-markdown")).toHaveTextContent("Found the bug")
    expect(screen.getAllByTestId("task-comment-attachment")).toHaveLength(2)
  })

  it("adds a comment as the operator and clears the input", async () => {
    const user = userEvent.setup()
    storeTasks = { t1: { id: "t1", comments: [] } }
    render(<TaskComments taskId="t1" />)
    const input = screen.getByTestId("task-comment-input")
    await user.type(input, "Looks good to me")
    await user.click(screen.getByText("add"))
    expect(addTaskCommentMock).toHaveBeenCalledWith({
      taskId: "t1",
      authorId: "user",
      text: "Looks good to me",
    })
    expect(toastSuccess).toHaveBeenCalledWith("added")
    expect(input).toHaveValue("")
  })

  it("ignores a blank comment", async () => {
    const user = userEvent.setup()
    storeTasks = { t1: { id: "t1", comments: [] } }
    render(<TaskComments taskId="t1" />)
    await user.type(screen.getByTestId("task-comment-input"), "   ")
    await user.click(screen.getByText("add"))
    expect(addTaskCommentMock).not.toHaveBeenCalled()
  })

  it("submits on ⌘/Ctrl+Enter", () => {
    storeTasks = { t1: { id: "t1", comments: [] } }
    render(<TaskComments taskId="t1" />)
    const input = screen.getByTestId("task-comment-input")
    fireEvent.change(input, { target: { value: "ship it" } })
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true })
    expect(addTaskCommentMock).toHaveBeenCalledWith(expect.objectContaining({ text: "ship it" }))
  })

  it("copies the ref when a file attachment chip is clicked", async () => {
    const user = userEvent.setup()
    storeTasks = {
      t1: {
        id: "t1",
        comments: [
          makeComment({
            attachments: [{ id: "a1", name: "log", kind: "file", ref: "logs/a.txt" }],
          }),
        ],
      },
    }
    render(<TaskComments taskId="t1" />)
    await user.click(screen.getByTestId("task-comment-attachment"))
    expect(copyMock).toHaveBeenCalledWith("logs/a.txt")
    expect(toastSuccess).toHaveBeenCalledWith("refCopied")
  })

  it("renders link attachments as a new-tab anchor", () => {
    storeTasks = {
      t1: {
        id: "t1",
        comments: [
          makeComment({
            attachments: [{ id: "a1", name: "spec", kind: "link", ref: "https://x/y" }],
          }),
        ],
      },
    }
    render(<TaskComments taskId="t1" />)
    const chip = screen.getByTestId("task-comment-attachment")
    expect(chip).toHaveAttribute("href", "https://x/y")
    expect(chip).toHaveAttribute("target", "_blank")
  })

  it("renders the empty state when the task is missing", () => {
    storeTasks = {}
    render(<TaskComments taskId="ghost" />)
    expect(screen.getByText("empty")).toBeInTheDocument()
  })

  it("handles string + invalid timestamps and an artifact attachment", () => {
    storeTasks = {
      t1: {
        id: "t1",
        comments: [
          makeComment({
            id: "cs",
            createdAt: "2026-06-29T10:00:00Z" as unknown as Date,
            attachments: [{ id: "a1", name: "doc", kind: "artifact", ref: "artifact-1" }],
          }),
          makeComment({ id: "cb", createdAt: "not-a-date" as unknown as Date }),
        ],
      },
    }
    render(<TaskComments taskId="t1" />)
    expect(screen.getByTestId("task-comment-cs")).toBeInTheDocument()
    expect(screen.getByTestId("task-comment-cb")).toBeInTheDocument()
    expect(screen.getByTestId("task-comment-attachment")).toBeInTheDocument()
  })

  it("keeps the input when addTaskComment returns null", async () => {
    const user = userEvent.setup()
    addTaskCommentMock.mockReturnValueOnce(null as never)
    storeTasks = { t1: { id: "t1", comments: [] } }
    render(<TaskComments taskId="t1" />)
    const input = screen.getByTestId("task-comment-input")
    await user.type(input, "rejected text")
    await user.click(screen.getByText("add"))
    expect(addTaskCommentMock).toHaveBeenCalled()
    expect(toastSuccess).not.toHaveBeenCalled()
    expect(input).toHaveValue("rejected text")
  })
})
