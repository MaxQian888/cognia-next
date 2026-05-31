/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

jest.mock("./platform-badge", () => ({
  PlatformBadge: ({ platform }: { platform: string }) => <span data-testid={`badge-${platform}`} />,
}))

jest.mock("./unread-pill", () => ({
  UnreadPill: ({ count }: { count: number }) =>
    count > 0 ? <span data-testid="unread-pill">{count}</span> : null,
}))

import { ConversationRow, type ConversationRowItem } from "./conversation-row"
import type { ChatSession } from "@/lib/claude/types"
import type { ConversationOverrideRow } from "@/lib/db/connector-types"

function makeItem(overrides: Partial<ConversationRowItem> = {}): ConversationRowItem {
  const session = {
    id: "s1",
    title: "Product team",
    kind: "direct",
    createdAt: 1,
    updatedAt: 2,
    platformBinding: { adapterId: "a1", conversationKey: "slack:a1:C1", platform: "slack" },
  } as unknown as ChatSession
  return {
    session,
    override: undefined,
    unreadCount: 0,
    lastMessagePreview: "Hello there",
    lastMessageAt: 1_700_000_000_000,
    ...overrides,
  }
}

describe("ConversationRow", () => {
  it("renders the title, preview, platform badge, and relative time", () => {
    render(<ConversationRow item={makeItem()} isActive={false} onSelect={() => {}} />)
    expect(screen.getByText("Product team")).toBeInTheDocument()
    expect(screen.getByText("Hello there")).toBeInTheDocument()
    expect(screen.getByTestId("badge-slack")).toBeInTheDocument()
    expect(screen.getByTestId("conversation-row-time-slack:a1:C1")).toBeInTheDocument()
  })

  it("falls back to the noPreview label when no message text exists", () => {
    render(
      <ConversationRow
        item={makeItem({ lastMessagePreview: undefined, lastMessageAt: undefined })}
        isActive={false}
        onSelect={() => {}}
      />
    )
    expect(screen.getByText("No messages yet")).toBeInTheDocument()
    // No timestamp without a lastMessageAt.
    expect(screen.queryByTestId("conversation-row-time-slack:a1:C1")).not.toBeInTheDocument()
  })

  it("shows the unread pill only when there are unread messages", () => {
    const { rerender } = render(
      <ConversationRow item={makeItem({ unreadCount: 0 })} isActive={false} onSelect={() => {}} />
    )
    expect(screen.queryByTestId("unread-pill")).not.toBeInTheDocument()
    rerender(
      <ConversationRow item={makeItem({ unreadCount: 3 })} isActive={false} onSelect={() => {}} />
    )
    expect(screen.getByTestId("unread-pill")).toHaveTextContent("3")
  })

  it("renders a pending-draft badge when draftCount > 0", () => {
    render(
      <ConversationRow item={makeItem()} draftCount={2} isActive={false} onSelect={() => {}} />
    )
    expect(screen.getByTestId("conversation-row-draft-slack:a1:C1")).toBeInTheDocument()
  })

  it("does not render a draft badge when draftCount is 0", () => {
    render(<ConversationRow item={makeItem()} isActive={false} onSelect={() => {}} />)
    expect(screen.queryByTestId("conversation-row-draft-slack:a1:C1")).not.toBeInTheDocument()
  })

  it("shows a pin icon when the conversation is pinned", () => {
    const override = { conversationKey: "slack:a1:C1", pinned: true } as ConversationOverrideRow
    const { container } = render(
      <ConversationRow item={makeItem({ override })} isActive={false} onSelect={() => {}} />
    )
    expect(container.querySelector("svg.lucide-pin")).toBeInTheDocument()
  })

  it("invokes onSelect with the conversationKey on click", () => {
    const onSelect = jest.fn()
    render(<ConversationRow item={makeItem()} isActive={false} onSelect={onSelect} />)
    fireEvent.click(screen.getByTestId("conversation-row-button-slack:a1:C1"))
    expect(onSelect).toHaveBeenCalledWith("slack:a1:C1")
  })

  it("applies the active background when isActive", () => {
    render(<ConversationRow item={makeItem()} isActive onSelect={() => {}} />)
    expect(screen.getByTestId("conversation-row-slack:a1:C1")).toHaveClass("bg-muted")
  })
})
