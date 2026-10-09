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

// Stand in for a plugin contribution so the slot wrapper actually renders (the
// real slot returns null with no registered extensions) and forwards the
// `className` it is given, exactly as `PluginExtensionSlot` does.
const mockSlotAction = jest.fn()
jest.mock("@/components/plugins/plugin-extension-slot", () => ({
  PluginExtensionSlot: ({ point, className }: { point: string; className?: string }) => (
    <div data-testid="conversation-row-plugin-slot" data-point={point} className={className}>
      <button type="button" onClick={() => mockSlotAction()}>
        plugin action
      </button>
    </div>
  ),
}))

jest.mock("@/components/ui/dropdown-menu")
jest.mock("@/components/ui/tooltip")
jest.mock("@/lib/data-hooks/context", () => ({ useCharacters: () => [] }))
jest.mock("@/hooks/connectors/use-conversation-labels", () => ({ useConversationLabels: () => [] }))

const mockApprovalCount = jest.fn((_sessionId: string) => 0)
jest.mock("@/hooks/connectors/use-pending-approval-count", () => ({
  usePendingApprovalCount: (sessionId: string) => mockApprovalCount(sessionId),
}))

import { ConversationRow, type ConversationRowItem } from "./conversation-row"
import type { ChatSession } from "@cognia/agent-config-types"
import type { ConversationOverrideRow } from "@/lib/db/connector-types"
import {
  HOVER_REVEAL_FORBIDDEN_CLASSES,
  HOVER_REVEAL_REQUIRED_VARIANTS,
} from "@/lib/ui/hover-reveal"

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
    const item = makeItem()
    item.session.pinned = true
    const { container } = render(
      <ConversationRow item={item} isActive={false} onSelect={() => {}} />
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
    expect(onSelect).toHaveBeenCalledWith("slack:a1:C1", "s1")
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

  // The plugin actions used to reveal only on a hover of the named `row` group
  // (at md+), so a keyboard focus inside the slot, an open plugin popup, or a
  // tablet-width touch screen never showed them.
  it("keeps the plugin actions reachable without a hover", () => {
    mockSlotAction.mockClear()
    render(<ConversationRow item={makeItem()} isActive={false} onSelect={() => {}} />)
    const slot = screen.getByTestId("conversation-row-plugin-slot")
    expect(slot).toHaveAttribute("data-point", "inbox.conversation.actions")
    for (const variant of HOVER_REVEAL_REQUIRED_VARIANTS.groupBase) {
      expect(slot).toHaveClass(variant)
    }
    // Mouse path is unchanged: the named row group, plus the existing
    // keyboard path and the always-visible narrow layout.
    expect(slot).toHaveClass(
      "group-hover/row:opacity-100",
      "group-focus-within/row:opacity-100",
      "max-md:opacity-100"
    )
    for (const forbidden of HOVER_REVEAL_FORBIDDEN_CLASSES) {
      expect(slot).not.toHaveClass(forbidden)
    }

    const action = screen.getByRole("button", { name: "plugin action" })
    action.focus()
    expect(action).toHaveFocus()
    fireEvent.click(action)
    expect(mockSlotAction).toHaveBeenCalledTimes(1)
  })

  describe("preview mode (onOpen given)", () => {
    it("selects on click and opens on double-click", () => {
      const onSelect = jest.fn()
      const onOpen = jest.fn()
      render(
        <ConversationRow item={makeItem()} isActive={false} onSelect={onSelect} onOpen={onOpen} />
      )
      const button = screen.getByRole("button", { name: "Preview conversation: Product team" })
      fireEvent.click(button)
      expect(onSelect).toHaveBeenCalledWith("slack:a1:C1", "s1")
      expect(onOpen).not.toHaveBeenCalled()
      fireEvent.doubleClick(button)
      expect(onOpen).toHaveBeenCalledWith("slack:a1:C1", "s1")
    })

    it("opens on Enter and leaves Space to the native select", () => {
      const onSelect = jest.fn()
      const onOpen = jest.fn()
      render(
        <ConversationRow item={makeItem()} isActive={false} onSelect={onSelect} onOpen={onOpen} />
      )
      const button = screen.getByTestId("conversation-row-button-slack:a1:C1")
      expect(button).toHaveAttribute("aria-keyshortcuts", "Enter")
      fireEvent.keyDown(button, { key: "Enter" })
      expect(onOpen).toHaveBeenCalledTimes(1)
      fireEvent.keyDown(button, { key: " " })
      expect(onOpen).toHaveBeenCalledTimes(1)
    })

    it("ignores Enter while an IME composition is in progress", () => {
      const onOpen = jest.fn()
      render(
        <ConversationRow item={makeItem()} isActive={false} onSelect={() => {}} onOpen={onOpen} />
      )
      fireEvent.keyDown(screen.getByTestId("conversation-row-button-slack:a1:C1"), {
        key: "Enter",
        isComposing: true,
      })
      expect(onOpen).not.toHaveBeenCalled()
    })

    it("marks the previewed row as current and selected", () => {
      render(<ConversationRow item={makeItem()} isActive onSelect={() => {}} onOpen={() => {}} />)
      const button = screen.getByTestId("conversation-row-button-slack:a1:C1")
      expect(button).toHaveAttribute("aria-current", "true")
      expect(button).toHaveAttribute("data-selected", "true")
    })
  })

  it("keeps the open-mode name and no Enter shortcut without onOpen", () => {
    render(<ConversationRow item={makeItem()} isActive={false} onSelect={() => {}} />)
    const button = screen.getByRole("button", { name: "Open conversation: Product team" })
    expect(button).not.toHaveAttribute("aria-keyshortcuts")
  })

  it("renders the leading slot outside the click target", () => {
    render(
      <ConversationRow
        item={makeItem()}
        isActive={false}
        onSelect={() => {}}
        leading={<input type="checkbox" aria-label="select" />}
      />
    )
    const checkbox = screen.getByRole("checkbox", { name: "select" })
    expect(screen.getByTestId("conversation-row-button-slack:a1:C1")).not.toContainElement(checkbox)
    expect(screen.getByTestId("conversation-row-slack:a1:C1")).toContainElement(checkbox)
  })

  describe("triage at a glance", () => {
    const NOW = new Date(1_700_000_000_000)
    const labelsById = new Map([
      ["l1", { id: "l1", name: "VIP", color: "#f00", scope: "conversation", sortOrder: 0 }],
      ["l2", { id: "l2", name: "Bug", scope: "conversation", sortOrder: 1 }],
      ["l3", { id: "l3", name: "Lead", scope: "conversation", sortOrder: 2 }],
    ] as const)

    function withOverride(over: Partial<ConversationOverrideRow>) {
      return makeItem({
        override: { id: "o", conversationKey: "slack:a1:C1", ...over } as ConversationOverrideRow,
      })
    }

    it("draws up to two label dots and a +n, naming them all", () => {
      render(
        <ConversationRow
          item={withOverride({ labelIds: ["l1", "l2", "l3", "gone"] })}
          isActive={false}
          onSelect={() => {}}
          labelsById={labelsById as never}
          now={NOW}
        />
      )
      const dots = screen.getByTestId("conversation-row-labels-slack:a1:C1")
      expect(dots).toHaveAccessibleName("Labels: VIP, Bug, Lead")
      expect(dots.querySelectorAll("span.rounded-full")).toHaveLength(2)
      expect(dots).toHaveTextContent("+1")
    })

    it("shows the assignee as initials, a person glyph for me", () => {
      const { rerender } = render(
        <ConversationRow
          item={withOverride({ assignee: { kind: "character", id: "c", label: "Ava Bot" } })}
          isActive={false}
          onSelect={() => {}}
          now={NOW}
        />
      )
      const token = screen.getByTestId("conversation-row-assignee-slack:a1:C1")
      expect(token).toHaveTextContent("AB")
      expect(token).toHaveAccessibleName("Assignee: Ava Bot")
      rerender(
        <ConversationRow
          item={withOverride({ assignee: { kind: "human" } })}
          isActive={false}
          onSelect={() => {}}
          now={NOW}
        />
      )
      expect(screen.getByTestId("conversation-row-assignee-slack:a1:C1")).toHaveAttribute(
        "data-assignee-kind",
        "human"
      )
    })

    it("flags an SLA only when overdue or nearly due", () => {
      const { rerender } = render(
        <ConversationRow
          item={withOverride({ nextResponseDueAt: NOW.getTime() - 1 })}
          isActive={false}
          onSelect={() => {}}
          now={NOW}
        />
      )
      expect(screen.getByTestId("conversation-row-sla-slack:a1:C1")).toHaveTextContent("Overdue")
      rerender(
        <ConversationRow
          item={withOverride({ nextResponseDueAt: NOW.getTime() + 10 * 60_000 })}
          isActive={false}
          onSelect={() => {}}
          now={NOW}
        />
      )
      expect(screen.getByTestId("conversation-row-sla-slack:a1:C1")).toHaveAccessibleName(
        "Reply due in 10 minutes"
      )
      rerender(
        <ConversationRow
          item={withOverride({ nextResponseDueAt: NOW.getTime() + 5 * 3_600_000 })}
          isActive={false}
          onSelect={() => {}}
          now={NOW}
        />
      )
      expect(screen.queryByTestId("conversation-row-sla-slack:a1:C1")).not.toBeInTheDocument()
    })

    it("marks pending approvals from the approval registry", () => {
      mockApprovalCount.mockImplementation((id) => (id === "s1" ? 2 : 0))
      render(<ConversationRow item={makeItem()} isActive={false} onSelect={() => {}} />)
      expect(screen.getByTestId("conversation-row-approvals-slack:a1:C1")).toHaveAccessibleName(
        "2 pending approvals"
      )
      mockApprovalCount.mockReturnValue(0)
    })
  })

  describe("menus and selection", () => {
    it("offers the triage menu and reports its choices", () => {
      const onTriage = jest.fn()
      render(
        <ConversationRow
          item={makeItem({ unreadCount: 1 })}
          isActive={false}
          onSelect={() => {}}
          onTriage={onTriage}
          menuMode="full"
          onMenuModeChange={() => {}}
        />
      )
      fireEvent.click(screen.getByTestId("row-menu-toggle-read"))
      expect(onTriage).toHaveBeenCalledWith({ kind: "markRead" })
    })

    it("opens the phone's action sheet from ⋯ when it has no menu", () => {
      const onOpenActions = jest.fn()
      render(
        <ConversationRow
          item={makeItem()}
          isActive={false}
          onSelect={() => {}}
          onOpenActions={onOpenActions}
        />
      )
      fireEvent.click(screen.getByTestId("conversation-row-actions-slack:a1:C1"))
      expect(onOpenActions).toHaveBeenCalled()
      expect(screen.queryByTestId("conversation-row-menu-slack:a1:C1")).not.toBeInTheDocument()
    })

    it("reports a pressed state and a select name in touch selection mode", () => {
      render(
        <ConversationRow item={makeItem()} isActive={false} onSelect={() => {}} pressed checked />
      )
      const button = screen.getByRole("button", { name: "Select conversation: Product team" })
      expect(button).toHaveAttribute("aria-pressed", "true")
      expect(screen.getByTestId("conversation-row-slack:a1:C1")).toHaveAttribute(
        "data-checked",
        "true"
      )
    })

    it("tags the row button for the keyboard model", () => {
      render(<ConversationRow item={makeItem()} isActive={false} onSelect={() => {}} />)
      expect(screen.getByTestId("conversation-row-button-slack:a1:C1")).toHaveAttribute(
        "data-inbox-row-select",
        "s1"
      )
    })

    it("forwards the context menu", () => {
      const onContextMenu = jest.fn()
      render(
        <ConversationRow
          item={makeItem()}
          isActive={false}
          onSelect={() => {}}
          onContextMenu={onContextMenu}
        />
      )
      fireEvent.contextMenu(screen.getByTestId("conversation-row-button-slack:a1:C1"))
      expect(onContextMenu).toHaveBeenCalled()
    })
  })
})
