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
import type { ChatSession } from "@cognia/agent-config-types"
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

  it("shows a status dot for a non-open status and hides it for open", () => {
    const resolved = render(
      <ConversationRow
        item={makeItem({
          override: {
            conversationKey: "slack:a1:C1",
            status: "resolved",
          } as ConversationOverrideRow,
        })}
        isActive={false}
        onSelect={() => {}}
      />
    )
    expect(resolved.getByTestId("conversation-row-status-slack:a1:C1")).toBeInTheDocument()
    resolved.unmount()

    const open = render(
      <ConversationRow
        item={makeItem({
          override: { conversationKey: "slack:a1:C1", status: "open" } as ConversationOverrideRow,
        })}
        isActive={false}
        onSelect={() => {}}
      />
    )
    expect(open.queryByTestId("conversation-row-status-slack:a1:C1")).not.toBeInTheDocument()
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

  // `bg-muted` (active) and `bg-muted/60` (hover) are near-identical, so the
  // fill alone could not say which row was selected.
  it("marks the active row with an accent rail and aria-current", () => {
    render(<ConversationRow item={makeItem()} isActive onSelect={() => {}} />)
    expect(screen.getByTestId("conversation-row-slack:a1:C1")).toHaveClass("before:bg-primary")
    expect(screen.getByTestId("conversation-row-button-slack:a1:C1")).toHaveAttribute(
      "aria-current",
      "true"
    )
  })

  // Hovering an already-selected row used to *lighten* it, because
  // `hover:bg-muted/60` sat on top of the active `bg-muted`.
  it("drops the hover fill on the active row", () => {
    const { rerender } = render(
      <ConversationRow item={makeItem()} isActive={false} onSelect={() => {}} />
    )
    expect(screen.getByTestId("conversation-row-slack:a1:C1")).toHaveClass("hover:bg-muted/60")

    rerender(<ConversationRow item={makeItem()} isActive onSelect={() => {}} />)
    expect(screen.getByTestId("conversation-row-slack:a1:C1")).not.toHaveClass("hover:bg-muted/60")
  })

  it("leaves a read row unmarked and aria-current-free", () => {
    render(<ConversationRow item={makeItem()} isActive={false} onSelect={() => {}} />)
    expect(screen.getByTestId("conversation-row-slack:a1:C1")).not.toHaveClass("before:bg-primary")
    expect(screen.getByTestId("conversation-row-button-slack:a1:C1")).not.toHaveAttribute(
      "aria-current"
    )
  })

  // Unread has to read at a glance from typography, not only from the pill.
  it("weights the title and preview of an unread row", () => {
    render(
      <ConversationRow item={makeItem({ unreadCount: 3 })} isActive={false} onSelect={() => {}} />
    )
    expect(screen.getByText("Product team")).toHaveClass("font-semibold")
    expect(screen.getByText("Hello there")).toHaveClass("text-foreground/80")
  })

  it("keeps a read row at the resting weight", () => {
    render(
      <ConversationRow item={makeItem({ unreadCount: 0 })} isActive={false} onSelect={() => {}} />
    )
    expect(screen.getByText("Product team")).toHaveClass("font-medium")
    expect(screen.getByText("Hello there")).toHaveClass("text-muted-foreground")
  })
})
