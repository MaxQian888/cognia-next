/**
 * CommentPanel - Unit Tests
 */

import React from "react"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { CommentPanel } from "./comment-panel"

// Bypass TooltipProvider context (production wraps the app at layout.tsx).
jest.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

// Mock next-intl
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) => {
    const translations: Record<string, string> = {
      comments: "Comments",
      addComment: "Add Comment",
      lines: "Lines",
      linesRange: `Lines ${params?.start}-${params?.end}`,
      commentsCount: `${params?.count} comments`,
      hideResolved: "Hide Resolved",
      showResolved: "Show Resolved",
      noComments: "No comments yet",
      reply: "Reply",
      cancel: "Cancel",
      resolve: "Mark as resolved",
      unresolve: "Reopen",
      writeReply: "Write a reply...",
      justNow: "just now",
      minutesAgo: `${params?.count} minutes ago`,
      hoursAgo: `${params?.count} hours ago`,
      daysAgo: `${params?.count} days ago`,
    }
    return translations[key] || key
  },
}))

// Mock useCommentStore
const mockAddComment = jest.fn()
const mockDeleteComment = jest.fn()
const mockResolveComment = jest.fn()
const mockUnresolveComment = jest.fn()
const mockAddReaction = jest.fn()
const mockRemoveReaction = jest.fn()
const mockReplyToComment = jest.fn()
const mockGetCommentsForDocument = jest.fn().mockReturnValue([])
const mockGetUnresolvedComments = jest.fn().mockReturnValue([])

const mockLoadCommentsForDocument = jest.fn().mockResolvedValue(undefined)

jest.mock("@/stores/canvas/comment-store", () => ({
  useCommentStore: () => ({
    addComment: mockAddComment,
    deleteComment: mockDeleteComment,
    resolveComment: mockResolveComment,
    unresolveComment: mockUnresolveComment,
    addReaction: mockAddReaction,
    removeReaction: mockRemoveReaction,
    replyToComment: mockReplyToComment,
    getCommentsForDocument: mockGetCommentsForDocument,
    getUnresolvedComments: mockGetUnresolvedComments,
    loadCommentsForDocument: mockLoadCommentsForDocument,
  }),
}))

// Mock formatRelativeDate
jest.mock("@/lib/canvas/utils", () => ({
  formatRelativeDate: (date: Date, t: (key: string) => string) => t("justNow"),
}))

describe("CommentPanel", () => {
  const defaultProps = {
    documentId: "doc-123",
    currentUserId: "user-1",
    currentUserName: "Test User",
  }

  beforeEach(() => {
    jest.clearAllMocks()
    mockGetCommentsForDocument.mockReturnValue([])
    mockGetUnresolvedComments.mockReturnValue([])
  })

  it("should render the comments button", () => {
    render(<CommentPanel {...defaultProps} />)
    expect(screen.getByText("Comments")).toBeInTheDocument()
  })

  it("should open panel when button is clicked", async () => {
    render(<CommentPanel {...defaultProps} />)

    const button = screen.getByText("Comments")
    await userEvent.click(button)

    // Panel title should be visible
    expect(screen.getAllByText("Comments").length).toBeGreaterThan(1)
  })

  it("should show add comment textarea", async () => {
    render(<CommentPanel {...defaultProps} />)

    const button = screen.getByText("Comments")
    await userEvent.click(button)

    expect(screen.getByPlaceholderText("Add Comment")).toBeInTheDocument()
  })

  it("should show no comments message when empty", async () => {
    render(<CommentPanel {...defaultProps} />)

    const button = screen.getByText("Comments")
    await userEvent.click(button)

    expect(screen.getByText("No comments yet")).toBeInTheDocument()
  })

  it("renders the no-comments state inside an Empty primitive (not a bare <p>)", async () => {
    render(<CommentPanel {...defaultProps} />)

    const button = screen.getByText("Comments")
    await userEvent.click(button)

    // The Empty primitive emits data-slot="empty" / data-slot="empty-description"
    // so we can prove the surface uses the shared component rather than a stub.
    const empty = document.querySelector('[data-slot="empty"]')
    expect(empty).toBeTruthy()
    const description = document.querySelector('[data-slot="empty-description"]')
    expect(description).toBeTruthy()
    expect(description?.textContent).toBe("No comments yet")
  })

  it("opens the Sheet at the new responsive width (min(90vw,480px))", async () => {
    render(<CommentPanel {...defaultProps} />)
    const button = screen.getByText("Comments")
    await userEvent.click(button)
    const sheets = document.querySelectorAll('[data-slot="sheet-content"]')
    const open = Array.from(sheets).find((el) => el.getAttribute("data-state") === "open")
    expect(open).toBeTruthy()
    expect(open?.className).toMatch(/sm:w-\[min\(90vw,480px\)\]/)
    expect(open?.className).not.toMatch(/sm:w-\[400px\]/)
  })

  it("should call addComment when submitting new comment", async () => {
    mockAddComment.mockReturnValue({
      id: "comment-1",
      content: "Test comment",
      authorId: "user-1",
      authorName: "Test User",
      createdAt: new Date(),
      reactions: [],
    })

    render(
      <CommentPanel
        {...defaultProps}
        selectedRange={{ startLine: 1, endLine: 5, startColumn: 0, endColumn: 0 }}
      />
    )

    const openButton = screen.getByText("Comments")
    await userEvent.click(openButton)

    const textarea = screen.getByPlaceholderText("Add Comment")
    await userEvent.type(textarea, "Test comment")

    const addButton = screen.getByRole("button", { name: /add comment/i })
    await userEvent.click(addButton)

    expect(mockAddComment).toHaveBeenCalledWith(
      "doc-123",
      expect.objectContaining({
        content: "Test comment",
        authorId: "user-1",
        authorName: "Test User",
      })
    )
  })

  it("should show selected range badge when provided", async () => {
    render(
      <CommentPanel
        {...defaultProps}
        selectedRange={{ startLine: 10, endLine: 15, startColumn: 0, endColumn: 0 }}
      />
    )

    const button = screen.getByText("Comments")
    await userEvent.click(button)

    expect(screen.getByText("Lines 10-15")).toBeInTheDocument()
  })

  it("should render custom trigger if provided", () => {
    render(<CommentPanel {...defaultProps} trigger={<button>Custom Trigger</button>} />)

    expect(screen.getByText("Custom Trigger")).toBeInTheDocument()
  })

  it("should show unresolved count in badge", () => {
    mockGetUnresolvedComments.mockReturnValue([
      { id: "1", content: "Comment 1" },
      { id: "2", content: "Comment 2" },
    ])

    render(<CommentPanel {...defaultProps} />)

    expect(screen.getByText("2")).toBeInTheDocument()
  })

  it("should toggle show/hide resolved comments", async () => {
    render(<CommentPanel {...defaultProps} />)

    const openButton = screen.getByText("Comments")
    await userEvent.click(openButton)

    const toggleButton = screen.getByText("Show Resolved")
    await userEvent.click(toggleButton)

    expect(screen.getByText("Hide Resolved")).toBeInTheDocument()
  })
})

describe("CommentPanel with comments", () => {
  const mockComments = [
    {
      id: "comment-1",
      content: "First comment",
      authorId: "user-1",
      authorName: "User One",
      createdAt: new Date(),
      reactions: [],
      range: { startLine: 1, endLine: 5 },
    },
    {
      id: "comment-2",
      content: "Second comment",
      authorId: "user-2",
      authorName: "User Two",
      createdAt: new Date(),
      reactions: [{ emoji: "👍", users: ["user-1"] }],
      range: { startLine: 10, endLine: 15 },
    },
  ]

  beforeEach(() => {
    jest.clearAllMocks()
    mockGetCommentsForDocument.mockReturnValue(mockComments)
    mockGetUnresolvedComments.mockReturnValue(mockComments)
  })

  it("should display comments list", async () => {
    render(<CommentPanel documentId="doc-123" />)

    const button = screen.getByText("Comments")
    await userEvent.click(button)

    expect(screen.getByText("First comment")).toBeInTheDocument()
    expect(screen.getByText("Second comment")).toBeInTheDocument()
  })

  it("should display comment author names", async () => {
    render(<CommentPanel documentId="doc-123" />)

    const button = screen.getByText("Comments")
    await userEvent.click(button)

    expect(screen.getByText("User One")).toBeInTheDocument()
    expect(screen.getByText("User Two")).toBeInTheDocument()
  })

  it("should display reactions on comments", async () => {
    render(<CommentPanel documentId="doc-123" />)

    const button = screen.getByText("Comments")
    await userEvent.click(button)

    expect(screen.getByText("👍 1")).toBeInTheDocument()
  })
})
