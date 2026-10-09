/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

let mockQueue: unknown[] | undefined = []
jest.mock("@/hooks/connectors/use-pending-drafts", () => ({
  usePendingDraftsQuery: () => mockQueue,
}))
jest.mock("../draft-editor", () => ({
  DraftEditor: ({ draft, onClose }: { draft: { id: string }; onClose?: () => void }) => (
    <div data-testid={`editor-${draft.id}`} data-has-close={String(Boolean(onClose))} />
  ),
}))

import { TriageDraftsSection } from "./triage-drafts-section"

const draft = (id: string, conversationKey: string) => ({
  id,
  conversationKey,
  sessionId: "s1",
  status: "pending",
  createdAt: 1,
  segments: [],
})

describe("TriageDraftsSection", () => {
  it("renders nothing while the queue loads", () => {
    mockQueue = undefined
    const { container } = render(<TriageDraftsSection conversationKey="ck" />)
    expect(container).toBeEmptyDOMElement()
  })

  it("renders nothing when this conversation has no drafts", () => {
    mockQueue = [draft("d9", "other")]
    const { container } = render(<TriageDraftsSection conversationKey="ck" />)
    expect(container).toBeEmptyDOMElement()
  })

  it("lists this conversation's drafts in inline editors under a counted heading", () => {
    mockQueue = [draft("d1", "ck"), draft("d2", "other"), draft("d3", "ck")]
    render(<TriageDraftsSection conversationKey="ck" />)
    expect(screen.getByRole("heading", { name: "2 drafts to review" })).toBeInTheDocument()
    expect(screen.getByTestId("editor-d1")).toBeInTheDocument()
    expect(screen.getByTestId("editor-d3")).toBeInTheDocument()
    expect(screen.queryByTestId("editor-d2")).not.toBeInTheDocument()
    // Inline: no surface to close, so Cancel discards edits rather than no-op.
    expect(screen.getByTestId("editor-d1")).toHaveAttribute("data-has-close", "false")
  })
})
