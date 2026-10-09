/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, within, act, waitFor } from "@testing-library/react"

// `useReducedMotion` (motion/react) reads matchMedia; jsdom lacks it.
beforeAll(() => {
  if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: (query: string) =>
        ({
          matches: false,
          media: query,
          onchange: null,
          addEventListener: () => {},
          removeEventListener: () => {},
          addListener: () => {},
          removeListener: () => {},
          dispatchEvent: () => false,
        }) as unknown as MediaQueryList,
    })
  }
})

const mockPin = jest.fn().mockResolvedValue(undefined)
const mockArchive = jest.fn().mockResolvedValue(undefined)
jest.mock("@/hooks/chat/use-sessions", () => ({
  useSessions: () => ({ bulkSetPinned: mockPin, archive: mockArchive, unarchive: mockArchive }),
}))

jest.mock("@/hooks/connectors/use-pending-drafts", () => ({
  usePendingDraftCounts: () => new Map<string, number>(),
}))

const mockLabels = [
  { id: "l1", name: "VIP", color: "#f00", scope: "conversation", sortOrder: 0 },
  { id: "l2", name: "Bug", color: "#0f0", scope: "conversation", sortOrder: 1 },
]
jest.mock("@/hooks/connectors/use-conversation-labels", () => ({
  useConversationLabels: () => mockLabels,
  useConversationLabelMap: () => new Map(mockLabels.map((label) => [label.id, label])),
}))
jest.mock("@/lib/data-hooks/context", () => ({ useCharacters: () => [] }))
jest.mock("@/lib/db/session-state", () => ({
  markSessionRead: jest.fn(async () => {}),
  markSessionUnread: jest.fn(async () => {}),
}))
jest.mock("@/lib/connectors/inbox-writes", () => ({
  mutateConversationOverride: jest.fn(async () => ({ route: "local" })),
}))
jest.mock("@/lib/connectors/assignment/notify-assignment", () => ({
  notifyAssignmentChanged: jest.fn(async () => {}),
}))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), warning: jest.fn(), error: jest.fn() } }))

// The phone's sheet and dock have their own suites; here they only need to
// show what the list hands them.
jest.mock("@/components/mobile/inbox/mobile-conversation-row-actions", () => ({
  MobileConversationRowActions: ({
    row,
    onPreview,
    onSelect,
    onRun,
  }: {
    row: { session: { id: string } } | null
    onPreview: (row: unknown) => void
    onSelect?: (row: unknown) => void
    onRun: (action: unknown, row: unknown) => void
  }) =>
    row ? (
      <div data-testid="mock-row-actions" data-session={row.session.id}>
        <button type="button" onClick={() => onPreview(row)}>
          sheet-preview
        </button>
        <button type="button" onClick={() => onSelect?.(row)}>
          sheet-select
        </button>
        <button type="button" onClick={() => onRun({ kind: "markRead" }, row)}>
          sheet-read
        </button>
      </div>
    ) : null,
}))
jest.mock("@/components/mobile/inbox/mobile-conversation-bulk-bar", () => ({
  MobileConversationBulkBar: ({
    rows,
    onRun,
  }: {
    rows: Array<{ session: { id: string } }>
    onRun: (action: unknown) => void
  }) => (
    <div data-testid="mock-dock" data-count={rows.length}>
      <button type="button" onClick={() => onRun({ kind: "setStatus", status: "resolved" })}>
        dock-resolve
      </button>
    </div>
  ),
}))

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

jest.mock("./platform-badge", () => ({
  PlatformBadge: ({ platform }: { platform: string }) => <span data-testid={`badge-${platform}`} />,
}))
jest.mock("./unread-pill", () => ({
  UnreadPill: ({ count }: { count: number }) =>
    count > 0 ? <span data-testid="unread-pill">{count}</span> : null,
}))
jest.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div data-slot="scroll-area" className={className}>
      {children}
    </div>
  ),
}))
// The shared manual mock renders menu content unconditionally and fires
// `onCheckedChange` on click, so the filter test ids stay reachable.
jest.mock("@/components/ui/dropdown-menu")
jest.mock("@/components/ui/tooltip")
jest.mock("@/components/ui/sidebar", () => ({
  SidebarTrigger: ({
    className,
    "data-testid": testId,
    "aria-label": ariaLabel,
  }: {
    className?: string
    "data-testid"?: string
    "aria-label"?: string
  }) => <button type="button" data-testid={testId} aria-label={ariaLabel} className={className} />,
}))

import type { ChatSession } from "@cognia/agent-config-types"
import type { ConversationOverrideRow } from "@/lib/db/connector-types"
import type { ConversationRowItem } from "@/lib/inbox/conversation-grouping"
import type { InboxListFilter } from "@/lib/inbox/inbox-url-state"
import { useInboxLayoutStore } from "@/stores/inbox/inbox-layout-store"
import { mutateConversationOverride } from "@/lib/connectors/inbox-writes"
import { markSessionRead } from "@/lib/db/session-state"
import { ConversationList, type ConversationListProps } from "./conversation-list"

const mockMutate = mutateConversationOverride as jest.Mock
const mockMarkRead = markSessionRead as jest.Mock

function makeSession(
  id: string,
  ck: string,
  updatedAt: number,
  binding: { adapterId?: string; platform?: string } = {}
): ChatSession {
  const adapterId = binding.adapterId ?? "a1"
  const platform = binding.platform ?? "telegram"
  return {
    id,
    title: `Chat ${id}`,
    kind: "direct",
    createdAt: updatedAt - 1000,
    updatedAt,
    platformBinding: {
      adapterId,
      conversationKey: ck,
      platform,
      conversationRef: { platform, adapterId },
    },
  } as unknown as ChatSession
}

function override(
  ck: string,
  opts: Partial<ConversationOverrideRow> = {}
): ConversationOverrideRow {
  return {
    id: `ov_${ck}`,
    conversationKey: ck,
    sessionId: "s1",
    ...opts,
  } as ConversationOverrideRow
}

function row(session: ChatSession, extra: Partial<ConversationRowItem> = {}): ConversationRowItem {
  return { session, override: undefined, unreadCount: 0, ...extra }
}

function renderList(props: Partial<ConversationListProps> = {}) {
  const handlers = {
    onToggleFilter: jest.fn(),
    onClearFilters: jest.fn(),
    onSelectSession: jest.fn(),
    onOpenSession: jest.fn(),
    onClearPreview: jest.fn(),
    onPreviewSession: jest.fn(),
    onTouchSelectingChange: jest.fn(),
  }
  const utils = render(
    <ConversationList
      rows={[]}
      grouping="status"
      filters={[]}
      selectionMode="preview"
      {...handlers}
      {...props}
    />
  )
  return { ...utils, ...handlers }
}

beforeEach(() => {
  window.localStorage.clear()
  act(() => useInboxLayoutStore.getState().reset())
  mockPin.mockClear()
  mockArchive.mockClear()
  mockMutate.mockClear()
  mockMarkRead.mockClear()
})

beforeAll(() => {
  Element.prototype.scrollIntoView = jest.fn()
})

describe("ConversationList", () => {
  it("shows a skeleton, not the empty state, while rows load", () => {
    const { container } = renderList({ rows: undefined })
    expect(screen.getByTestId("conversation-list-loading")).toBeInTheDocument()
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0)
    expect(screen.queryByTestId("conversation-list-empty")).not.toBeInTheDocument()
  })

  it("shows a failed read with a retry inside the list", () => {
    const onRetry = jest.fn()
    renderList({ rows: undefined, error: new Error("TransactionInactiveError"), onRetry })
    // The storage error's own text is internal English; the card says it in
    // the user's language.
    const card = screen.getByTestId("conversation-list-error")
    expect(card).toHaveTextContent("Couldn't load conversations")
    expect(card).not.toHaveTextContent("TransactionInactiveError")
    fireEvent.click(screen.getByRole("button", { name: /retry/i }))
    expect(onRetry).toHaveBeenCalled()
  })

  it("shows the empty state when there are no conversations", () => {
    renderList({ rows: [] })
    expect(screen.getByText("No conversations yet")).toBeInTheDocument()
  })

  it("sections status grouping into pinned, unread and read, in that order", () => {
    renderList({
      rows: [
        row(makeSession("s1", "ck-read", 3000)),
        row(makeSession("s2", "ck-unread", 2000), { unreadCount: 2 }),
        row({ ...makeSession("s3", "ck-pinned", 1000), pinned: true }, { unreadCount: 1 }),
      ],
    })
    const sections = screen.getAllByTestId(/^conversation-section-status:/)
    expect(sections.map((s) => s.getAttribute("data-testid"))).toEqual([
      "conversation-section-status:pinned",
      "conversation-section-status:unread",
      "conversation-section-status:read",
    ])
    // A pinned section mixes read and unread, so it says how many are unread;
    // the Unread section's own count already says it.
    expect(
      within(sections[0]!).getByTestId("conversation-section-unread-status:pinned")
    ).toHaveTextContent("1 unread")
    expect(
      within(sections[1]!).queryByTestId("conversation-section-unread-status:unread")
    ).not.toBeInTheDocument()
  })

  it("sections by adapter with display names and a link to each scope", () => {
    renderList({
      grouping: "adapter",
      adapters: [
        { id: "a1", displayName: "Support bot", type: "telegram" },
        { id: "a2", displayName: "Sales bot", type: "lark" },
      ],
      rows: [
        row(makeSession("s1", "ck1", 1, { adapterId: "a2", platform: "lark" })),
        row(makeSession("s2", "ck2", 2, { adapterId: "a1" })),
      ],
    })
    expect(screen.getByRole("region", { name: "Support bot" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Open Sales bot on its own" })).toHaveAttribute(
      "href",
      "/inbox/adapter?adapterId=a2"
    )
  })

  it("does not link a section back to the scope the route already shows", () => {
    renderList({
      grouping: "adapter",
      adapterId: "a1",
      adapters: [{ id: "a1", displayName: "Support bot", type: "telegram" }],
      rows: [row(makeSession("s1", "ck1", 1))],
    })
    expect(screen.queryByRole("link")).not.toBeInTheDocument()
  })

  it("sections by platform with localized platform names", () => {
    renderList({
      grouping: "platform",
      rows: [row(makeSession("s1", "ck1", 1, { platform: "lark" }))],
    })
    expect(screen.getByRole("region", { name: "Lark" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Open Lark on its own" })).toHaveAttribute(
      "href",
      "/inbox/platform?kind=lark"
    )
  })

  it("keeps resolved and archived conversations in collapsed tail sections", () => {
    renderList({
      rows: [
        row(makeSession("s1", "ck-resolved", 1), {
          override: override("ck-resolved", { status: "resolved" }),
        }),
        row({ ...makeSession("s2", "ck-archived", 2), archivedAt: 5 }),
      ],
    })
    expect(screen.queryByTestId("conversation-row-ck-resolved")).not.toBeInTheDocument()
    expect(screen.queryByTestId("conversation-row-ck-archived")).not.toBeInTheDocument()
    // No live rows: the empty state shows above the tails.
    expect(screen.getByTestId("conversation-list-empty")).toBeInTheDocument()

    fireEvent.click(screen.getByTestId("conversation-section-toggle-resolved"))
    expect(screen.getByTestId("conversation-row-ck-resolved")).toBeInTheDocument()
    // The choice persists for the next mount.
    expect(useInboxLayoutStore.getState().collapsedSections).toEqual({ resolved: false })
  })

  it("collapses a live section and keeps its list element for aria-controls", () => {
    renderList({ rows: [row(makeSession("s1", "ck1", 1))] })
    const toggle = screen.getByTestId("conversation-section-toggle-status:read")
    fireEvent.click(toggle)
    expect(screen.queryByTestId("conversation-row-ck1")).not.toBeInTheDocument()
    const listId = toggle.getAttribute("aria-controls")!
    expect(document.getElementById(listId)).toHaveAttribute("hidden")
  })

  describe("activation", () => {
    const rows = [row(makeSession("s5", "ck-nav", 1000))]

    it("preview mode: click selects, double-click opens", () => {
      const { onSelectSession, onOpenSession } = renderList({ rows })
      const button = screen.getByTestId("conversation-row-button-ck-nav")
      fireEvent.click(button)
      expect(onSelectSession).toHaveBeenCalledWith(rows[0])
      expect(onOpenSession).not.toHaveBeenCalled()
      fireEvent.doubleClick(button)
      expect(onOpenSession).toHaveBeenCalledWith(rows[0])
    })

    it("preview mode: Enter opens", () => {
      const { onOpenSession } = renderList({ rows })
      fireEvent.keyDown(screen.getByTestId("conversation-row-button-ck-nav"), { key: "Enter" })
      expect(onOpenSession).toHaveBeenCalledWith(rows[0])
    })

    it("open mode (phone): a tap opens the chat directly", () => {
      const { onSelectSession, onOpenSession } = renderList({ rows, selectionMode: "open" })
      fireEvent.click(screen.getByRole("button", { name: "Open conversation: Chat s5" }))
      expect(onOpenSession).toHaveBeenCalledWith(rows[0])
      expect(onSelectSession).not.toHaveBeenCalled()
    })

    it("marks the previewed session, distinguishing two sessions on one key", () => {
      renderList({
        rows: [row(makeSession("old", "same", 1)), row(makeSession("new", "same", 2))],
        selectedSessionId: "old",
      })
      expect(
        screen.getByRole("button", { name: "Preview conversation: Chat old" })
      ).toHaveAttribute("aria-current", "true")
      expect(
        screen.getByRole("button", { name: "Preview conversation: Chat new" })
      ).not.toHaveAttribute("aria-current")
    })

    it("renders a leading control per row when asked", () => {
      renderList({
        rows,
        renderRowLeading: (item) => (
          <input type="checkbox" aria-label={`pick ${item.session.id}`} />
        ),
      })
      expect(screen.getByRole("checkbox", { name: "pick s5" })).toBeInTheDocument()
    })
  })

  describe("filters", () => {
    const rows = [
      row(makeSession("s1", "ck-read", 1000)),
      row(makeSession("s2", "ck-unread", 2000), { unreadCount: 1 }),
      row({ ...makeSession("s3", "ck-pin", 3000), pinned: true }),
      row(makeSession("s4", "ck-pending", 4000), {
        override: override("ck-pending", { status: "pending" }),
      }),
    ]

    it.each<[InboxListFilter, string]>([
      ["unread", "ck-unread"],
      ["pinned", "ck-pin"],
      ["pending", "ck-pending"],
    ])("applies the %s filter from props", (filter, visible) => {
      renderList({ rows, filters: [filter] })
      expect(screen.getAllByTestId(/^conversation-row-button-/)).toHaveLength(1)
      expect(screen.getByTestId(`conversation-row-${visible}`)).toBeInTheDocument()
    })

    it("forwards filter menu toggles to the URL owner", () => {
      const { onToggleFilter } = renderList({ rows })
      fireEvent.click(screen.getByTestId("conversation-filter-unread"))
      expect(onToggleFilter).toHaveBeenCalledWith("unread")
    })

    it("shows removable pills for active filters", () => {
      const { onToggleFilter } = renderList({ rows, filters: ["pinned"] })
      fireEvent.click(screen.getByTestId("conversation-filter-chip-pinned"))
      expect(onToggleFilter).toHaveBeenCalledWith("pinned")
    })

    it("offers a reset from the filtered-empty state", () => {
      const { onClearFilters } = renderList({
        rows: [row(makeSession("s1", "ck", 1))],
        filters: ["unread"],
      })
      fireEvent.click(screen.getByTestId("conversation-filter-reset"))
      expect(onClearFilters).toHaveBeenCalled()
    })

    it("filters by title via the search input", async () => {
      const alpha = makeSession("sA", "ck-alpha", 1000)
      alpha.title = "Alpha conversation"
      const bravo = makeSession("sB", "ck-bravo", 2000)
      bravo.title = "Bravo conversation"
      renderList({ rows: [row(alpha), row(bravo)] })
      fireEvent.change(screen.getByTestId("conversation-search-input"), {
        target: { value: "alpha" },
      })
      await new Promise((resolve) => setTimeout(resolve, 250))
      expect(screen.queryByTestId("conversation-row-ck-alpha")).toBeInTheDocument()
      expect(screen.queryByTestId("conversation-row-ck-bravo")).not.toBeInTheDocument()
    })
  })

  it("puts the sidebar trigger on every width below lg (tablet included)", () => {
    renderList()
    const trigger = screen.getByTestId("conversation-list-open-sidebar")
    expect(trigger).toHaveClass("lg:hidden")
    expect(trigger).not.toHaveClass("md:hidden")
    expect(trigger).toHaveAccessibleName(/open conversations list/i)
  })

  it("row uses responsive touch-target sizing", () => {
    renderList({ rows: [row(makeSession("s7", "ck-touch", 1000))] })
    const element = screen.getByTestId("conversation-row-ck-touch")
    expect(element).toHaveClass("min-h-12")
    expect(element).toHaveClass("md:min-h-11")
  })

  it("pins and archives the exact session using common session actions", () => {
    renderList({ rows: [row(makeSession("shared", "same", 1))] })
    fireEvent.click(screen.getByText("Pin"))
    expect(mockPin).toHaveBeenCalledWith(["shared"], true)
    fireEvent.click(screen.getByText("Archive"))
    expect(mockArchive).toHaveBeenCalledWith("shared")
  })

  it("draws label dots, the assignee token and an SLA flag from the override", () => {
    renderList({
      rows: [
        row(makeSession("s1", "ck-meta", 1), {
          override: override("ck-meta", {
            labelIds: ["l1", "l2", "missing"],
            assignee: { kind: "team", id: "t1", label: "Ops Crew" },
            nextResponseDueAt: Date.now() - 1000,
          }),
        }),
      ],
    })
    expect(screen.getByTestId("conversation-row-labels-ck-meta")).toHaveAccessibleName(
      "Labels: VIP, Bug"
    )
    expect(screen.getByTestId("conversation-row-assignee-ck-meta")).toHaveTextContent("OC")
    expect(screen.getByTestId("conversation-row-sla-ck-meta")).toHaveAttribute(
      "data-sla",
      "overdue"
    )
  })

  describe("keyboard triage", () => {
    // Status grouping draws the unread k2 first: visible order is k2, k1, k3.
    const rows = [
      row(makeSession("k1", "ck-1", 3000)),
      row(makeSession("k2", "ck-2", 2000), { unreadCount: 1 }),
      row(makeSession("k3", "ck-3", 1000)),
    ]

    it("moves the preview with j / k and keeps focus on the row", () => {
      const { onSelectSession } = renderList({ rows, selectedSessionId: "k2" })
      const current = screen.getByTestId("conversation-row-button-ck-2")
      fireEvent.keyDown(current, { key: "j" })
      expect(onSelectSession).toHaveBeenCalledWith(rows[0])
      expect(document.activeElement).toBe(screen.getByTestId("conversation-row-button-ck-1"))
      fireEvent.keyDown(document.activeElement!, { key: "k" })
      expect(onSelectSession).toHaveBeenLastCalledWith(rows[1])
    })

    it("toggles read on the focused row with u", () => {
      renderList({ rows })
      fireEvent.keyDown(screen.getByTestId("conversation-row-button-ck-2"), { key: "u" })
      expect(mockMarkRead).toHaveBeenCalledWith("k2")
    })

    it("resolves with d and moves the preview to the next row", () => {
      const { onSelectSession } = renderList({ rows, selectedSessionId: "k1" })
      fireEvent.keyDown(screen.getByTestId("conversation-row-button-ck-1"), { key: "d" })
      expect(mockMutate).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "setStatus", status: "resolved", sessionId: "k1" })
      )
      expect(onSelectSession).toHaveBeenCalledWith(rows[2])
      expect(document.activeElement).toBe(screen.getByTestId("conversation-row-button-ck-3"))
    })

    it("checks rows with x, shows the bulk bar, and clears with Escape", () => {
      renderList({ rows })
      fireEvent.keyDown(screen.getByTestId("conversation-row-button-ck-1"), { key: "x" })
      fireEvent.keyDown(screen.getByTestId("conversation-row-button-ck-3"), { key: "x" })
      expect(screen.getByTestId("conversation-bulk-count")).toHaveTextContent("2 selected")
      // The bulk bar replaced the search header.
      expect(screen.queryByTestId("conversation-search-input")).not.toBeInTheDocument()
      fireEvent.keyDown(screen.getByTestId("conversation-row-button-ck-1"), { key: "Escape" })
      expect(screen.queryByTestId("conversation-bulk-bar")).not.toBeInTheDocument()
    })

    it("clears the preview on Escape when nothing is checked", () => {
      const { onClearPreview } = renderList({ rows, selectedSessionId: "k1" })
      fireEvent.keyDown(screen.getByTestId("conversation-row-button-ck-1"), { key: "Escape" })
      expect(onClearPreview).toHaveBeenCalled()
    })

    it("selects every visible row with ⌘A and runs a bulk action over them", async () => {
      renderList({ rows })
      fireEvent.keyDown(screen.getByTestId("conversation-row-button-ck-1"), {
        key: "a",
        metaKey: true,
      })
      expect(screen.getByTestId("conversation-bulk-count")).toHaveTextContent("3 selected")
      fireEvent.click(screen.getByTestId("conversation-bulk-resolve"))
      await waitFor(() => expect(mockMutate).toHaveBeenCalledTimes(3))
      // Everything landed: the selection is done.
      await waitFor(() =>
        expect(screen.queryByTestId("conversation-bulk-bar")).not.toBeInTheDocument()
      )
    })

    it("focuses the search with /", () => {
      renderList({ rows })
      fireEvent.keyDown(screen.getByTestId("conversation-row-button-ck-1"), { key: "/" })
      expect(document.activeElement).toBe(screen.getByTestId("conversation-search-input"))
    })

    it("opens the shortcuts help with ? and from the header button", async () => {
      renderList({ rows })
      fireEvent.keyDown(screen.getByTestId("conversation-row-button-ck-1"), { key: "?" })
      expect(await screen.findByTestId("inbox-shortcuts-help")).toBeInTheDocument()
    })

    it("extends a check with Shift-click on a row checkbox", () => {
      renderList({ rows })
      fireEvent.click(screen.getByTestId("conversation-row-check-k2"))
      fireEvent.click(screen.getByTestId("conversation-row-check-k3"), { shiftKey: true })
      expect(screen.getByTestId("conversation-bulk-count")).toHaveTextContent("3 selected")
      expect(screen.getByTestId("conversation-row-ck-1")).toHaveAttribute("data-checked", "true")
    })

    it("is off on the phone", () => {
      const { onSelectSession } = renderList({ rows, selectionMode: "open" })
      fireEvent.keyDown(screen.getByTestId("conversation-row-button-ck-1"), { key: "j" })
      expect(onSelectSession).not.toHaveBeenCalled()
      expect(screen.queryByTestId("conversation-list-shortcuts")).not.toBeInTheDocument()
    })
  })

  describe("phone", () => {
    const rows = [row(makeSession("p1", "ck-p1", 2000)), row(makeSession("p2", "ck-p2", 1000))]

    it("opens the action sheet from the row's ⋯ and the context menu", () => {
      const { onPreviewSession } = renderList({ rows, selectionMode: "open" })
      fireEvent.click(screen.getByTestId("conversation-row-actions-ck-p1"))
      expect(screen.getByTestId("mock-row-actions")).toHaveAttribute("data-session", "p1")
      fireEvent.click(screen.getByText("sheet-preview"))
      expect(onPreviewSession).toHaveBeenCalledWith(rows[0])
      fireEvent.contextMenu(screen.getByTestId("conversation-row-button-ck-p2"))
      expect(screen.getByTestId("mock-row-actions")).toHaveAttribute("data-session", "p2")
    })

    it("runs a sheet action on that row", () => {
      renderList({
        rows: [row(makeSession("p1", "ck-p1", 1), { unreadCount: 2 })],
        selectionMode: "open",
      })
      fireEvent.click(screen.getByTestId("conversation-row-actions-ck-p1"))
      fireEvent.click(screen.getByText("sheet-read"))
      expect(mockMarkRead).toHaveBeenCalledWith("p1")
    })

    it("offers swipe actions: read on one side, resolve and archive on the other", () => {
      renderList({ rows, selectionMode: "open" })
      const left = screen.getAllByTestId("swipe-row-left-actions")[0]!
      const right = screen.getAllByTestId("swipe-row-right-actions")[0]!
      expect(within(left).getByTestId("swipe-action-read")).toHaveTextContent("Mark as unread")
      expect(within(right).getByTestId("swipe-action-resolve")).toBeInTheDocument()
      expect(within(right).getByTestId("swipe-action-archive")).toBeInTheDocument()
    })

    it("in selection mode a tap checks the row and the dock runs over the checked rows", async () => {
      const { onOpenSession, onTouchSelectingChange } = renderList({
        rows,
        selectionMode: "open",
        touchSelecting: true,
      })
      const button = screen.getByRole("button", { name: "Select conversation: Chat p1" })
      fireEvent.click(button)
      expect(onOpenSession).not.toHaveBeenCalled()
      expect(button).toHaveAttribute("aria-pressed", "true")
      expect(screen.getByTestId("mock-dock")).toHaveAttribute("data-count", "1")
      // No swipe strips while picking.
      expect(screen.queryByTestId("swipe-row-left-actions")).not.toBeInTheDocument()
      fireEvent.click(screen.getByText("dock-resolve"))
      await waitFor(() =>
        expect(mockMutate).toHaveBeenCalledWith(
          expect.objectContaining({ kind: "setStatus", status: "resolved", sessionId: "p1" })
        )
      )
      await waitFor(() => expect(onTouchSelectingChange).toHaveBeenCalledWith(false))
    })

    it("starts selection from the sheet's Select", () => {
      const { onTouchSelectingChange } = renderList({ rows, selectionMode: "open" })
      fireEvent.click(screen.getByTestId("conversation-row-actions-ck-p2"))
      fireEvent.click(screen.getByText("sheet-select"))
      expect(onTouchSelectingChange).toHaveBeenCalledWith(true)
    })
  })
})
