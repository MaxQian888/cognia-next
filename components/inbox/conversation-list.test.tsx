/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockPush = jest.fn()

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/inbox",
  redirect: jest.fn(),
}))

jest.mock("@/lib/db/schema", () => ({ getDb: jest.fn() }))

// Platform badge / unread pill are implementation details; render simple stubs.
jest.mock("./platform-badge", () => ({
  PlatformBadge: ({ platform }: { platform: string }) => <span data-testid={`badge-${platform}`} />,
}))

jest.mock("./unread-pill", () => ({
  UnreadPill: ({ count }: { count: number }) =>
    count > 0 ? <span data-testid="unread-pill">{count}</span> : null,
}))

jest.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

// ---------------------------------------------------------------------------
// Build fake enriched data (mimic what useLiveQuery returns)
// ---------------------------------------------------------------------------

import type { ChatSession } from "@/lib/claude/types"
import type { ConversationOverrideRow } from "@/lib/db/connector-types"

interface EnrichedSession {
  session: ChatSession
  override: ConversationOverrideRow | undefined
  unreadCount: number
}

function makeSession(id: string, ck: string, updatedAt: number): ChatSession {
  return {
    id,
    title: `Chat ${id}`,
    kind: "direct",
    createdAt: updatedAt - 1000,
    updatedAt,
    platformBinding: {
      adapterId: "a1",
      conversationKey: ck,
      platform: "telegram",
      conversationRef: { platform: "telegram", adapterId: "a1" },
    },
  } as unknown as ChatSession
}

function makeOverride(
  ck: string,
  opts: Partial<ConversationOverrideRow> = {}
): ConversationOverrideRow {
  return {
    id: `ov_${ck}`,
    conversationKey: ck,
    sessionId: "s1",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...opts,
  }
}

// We'll control useLiveQuery at the module level so we can set different
// return values per test.
let mockEnriched: EnrichedSession[] | undefined = []

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: jest.fn().mockImplementation(() => mockEnriched),
}))

// ---------------------------------------------------------------------------
// Subject
// ---------------------------------------------------------------------------

import { ConversationList } from "./conversation-list"

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ConversationList", () => {
  beforeEach(() => {
    mockPush.mockReset()
  })

  it("shows empty state when no platform sessions exist", () => {
    mockEnriched = []
    render(<ConversationList />)
    expect(screen.getByText("No conversations yet")).toBeInTheDocument()
  })

  it("renders a row for each session", () => {
    mockEnriched = [
      { session: makeSession("s1", "ck1", 1000), override: undefined, unreadCount: 0 },
      { session: makeSession("s2", "ck2", 2000), override: undefined, unreadCount: 0 },
    ]
    render(<ConversationList />)
    expect(screen.getByTestId("conversation-row-ck1")).toBeInTheDocument()
    expect(screen.getByTestId("conversation-row-ck2")).toBeInTheDocument()
  })

  it("pinned conversations appear before unread conversations", () => {
    mockEnriched = [
      // Unread first in array
      { session: makeSession("s3", "ck-unread", 3000), override: undefined, unreadCount: 1 },
      // Pinned second in array (but should render first)
      {
        session: makeSession("s4", "ck-pinned", 2000),
        override: makeOverride("ck-pinned", { pinned: true }),
        unreadCount: 0,
      },
    ]
    render(<ConversationList />)

    const rows = screen.getAllByRole("button")
    // The pinned row should come before the unread row in the DOM.
    const pinnedIndex = rows.findIndex(
      (r) => r.getAttribute("data-testid") === "conversation-row-ck-pinned"
    )
    const unreadIndex = rows.findIndex(
      (r) => r.getAttribute("data-testid") === "conversation-row-ck-unread"
    )
    expect(pinnedIndex).toBeLessThan(unreadIndex)
  })

  it("clicking a row navigates to /inbox/c/<conversationKey>", () => {
    mockEnriched = [
      { session: makeSession("s5", "ck-nav", 1000), override: undefined, unreadCount: 0 },
    ]
    render(<ConversationList />)
    fireEvent.click(screen.getByTestId("conversation-row-ck-nav"))
    expect(mockPush).toHaveBeenCalledWith(`/inbox/c/${encodeURIComponent("ck-nav")}`)
  })

  it("archived conversations are hidden by default but shown after toggle", () => {
    mockEnriched = [
      {
        session: makeSession("s6", "ck-archived", 1000),
        override: makeOverride("ck-archived", { archived: true }),
        unreadCount: 0,
      },
    ]
    render(<ConversationList />)

    // Initially hidden
    expect(screen.queryByTestId("conversation-row-ck-archived")).not.toBeInTheDocument()

    // Show archived toggle button should be visible
    const toggleBtn = screen.getByRole("button", { name: /show 1 archived/i })
    fireEvent.click(toggleBtn)

    // Now visible
    expect(screen.getByTestId("conversation-row-ck-archived")).toBeInTheDocument()
  })

  it("shows loading skeleton when enriched is undefined", () => {
    mockEnriched = undefined
    const { container } = render(<ConversationList />)
    expect(container.querySelector(".animate-pulse")).toBeInTheDocument()
  })
})
