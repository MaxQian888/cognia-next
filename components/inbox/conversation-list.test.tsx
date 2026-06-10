/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

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

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockPush = jest.fn()

// Draft counts come from a separate live subscriber; isolate the list by
// returning an empty count map.
jest.mock("@/hooks/connectors/use-pending-drafts", () => ({
  usePendingDraftCounts: () => new Map<string, number>(),
  usePendingDrafts: () => [],
}))

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

jest.mock("@/components/ui/scroll-area")

// SidebarTrigger requires a SidebarProvider ancestor that isn't mounted in
// these unit tests. Stub it to a plain button so the trigger surface can still
// be asserted on.
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

    // The conversation row is now wrapped in a <div> (so plugin actions
    // can hang off the right side without a nested-button violation); the
    // click target is the inner <button> with testid
    // `conversation-row-button-${ck}`. Order is preserved across the
    // refactor — assert against the inner buttons.
    const rows = screen.getAllByRole("button")
    const pinnedIndex = rows.findIndex(
      (r) => r.getAttribute("data-testid") === "conversation-row-button-ck-pinned"
    )
    const unreadIndex = rows.findIndex(
      (r) => r.getAttribute("data-testid") === "conversation-row-button-ck-unread"
    )
    expect(pinnedIndex).toBeLessThan(unreadIndex)
  })

  it("clicking a row navigates to /inbox/c/<conversationKey>", () => {
    mockEnriched = [
      { session: makeSession("s5", "ck-nav", 1000), override: undefined, unreadCount: 0 },
    ]
    render(<ConversationList />)
    fireEvent.click(screen.getByTestId("conversation-row-button-ck-nav"))
    expect(mockPush).toHaveBeenCalledWith(`/inbox/c?key=${encodeURIComponent("ck-nav")}`)
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

  it("loading state uses the shadcn Skeleton primitive", () => {
    mockEnriched = undefined
    const { container } = render(<ConversationList />)
    const loadingPane = screen.getByTestId("conversation-list-loading")
    expect(loadingPane).toBeInTheDocument()
    // Skeleton primitive marks itself with data-slot="skeleton".
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0)
  })

  it("renders a mobile-only sidebar trigger in the header", () => {
    mockEnriched = []
    render(<ConversationList />)
    const trigger = screen.getByTestId("conversation-list-open-sidebar")
    expect(trigger).toBeInTheDocument()
    // The trigger must be visually hidden on md+ viewports so the desktop
    // three-pane layout keeps its existing chrome.
    expect(trigger).toHaveClass("md:hidden")
    // ConversationList mounts NextIntlClientProvider with the real en
    // messages, so the trigger resolves to the translation, not the key.
    expect(trigger).toHaveAccessibleName(/open conversations list/i)
  })

  it("row uses responsive touch-target sizing", () => {
    mockEnriched = [
      { session: makeSession("s7", "ck-touch", 1000), override: undefined, unreadCount: 0 },
    ]
    render(<ConversationList />)
    const row = screen.getByTestId("conversation-row-ck-touch")
    expect(row).toHaveClass("min-h-12")
    expect(row).toHaveClass("md:min-h-11")
  })

  it("filters rows by title via the search input", () => {
    const alpha = makeSession("sA", "ck-alpha", 1000)
    alpha.title = "Alpha conversation"
    const bravo = makeSession("sB", "ck-bravo", 2000)
    bravo.title = "Bravo conversation"
    mockEnriched = [
      { session: alpha, override: undefined, unreadCount: 0 },
      { session: bravo, override: undefined, unreadCount: 0 },
    ]
    render(<ConversationList />)
    const input = screen.getByTestId<HTMLInputElement>("conversation-search-input")
    fireEvent.change(input, { target: { value: "alpha" } })
    // Bypass the 200 ms debounce by waiting for the commit; React Testing
    // Library's fireEvent + microtask flush will let the controlled value
    // propagate once the timer fires. Use a microtask boundary.
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(screen.queryByTestId("conversation-row-ck-alpha")).toBeInTheDocument()
        expect(screen.queryByTestId("conversation-row-ck-bravo")).not.toBeInTheDocument()
        resolve()
      }, 250)
    })
  })

  it("unread filter chip hides read conversations", () => {
    mockEnriched = [
      { session: makeSession("s1", "ck-read", 1000), override: undefined, unreadCount: 0 },
      { session: makeSession("s2", "ck-unread", 2000), override: undefined, unreadCount: 1 },
    ]
    render(<ConversationList />)
    const chip = screen.getByTestId("conversation-filter-unread")
    fireEvent.click(chip)
    expect(screen.queryByTestId("conversation-row-ck-read")).not.toBeInTheDocument()
    expect(screen.queryByTestId("conversation-row-ck-unread")).toBeInTheDocument()
  })

  it("pinned filter chip hides unpinned conversations", () => {
    mockEnriched = [
      { session: makeSession("s1", "ck-plain", 1000), override: undefined, unreadCount: 0 },
      {
        session: makeSession("s2", "ck-pin", 2000),
        override: makeOverride("ck-pin", { pinned: true }),
        unreadCount: 0,
      },
    ]
    render(<ConversationList />)
    fireEvent.click(screen.getByTestId("conversation-filter-pinned"))
    expect(screen.queryByTestId("conversation-row-ck-plain")).not.toBeInTheDocument()
    expect(screen.queryByTestId("conversation-row-ck-pin")).toBeInTheDocument()
  })

  it("emptyFiltered state offers a reset action", () => {
    mockEnriched = [
      { session: makeSession("s1", "ck-x", 1000), override: undefined, unreadCount: 0 },
    ]
    render(<ConversationList />)
    fireEvent.click(screen.getByTestId("conversation-filter-unread"))
    expect(screen.getByTestId("conversation-list-empty")).toBeInTheDocument()
    const resetBtn = screen.getByTestId("conversation-filter-reset")
    fireEvent.click(resetBtn)
    expect(screen.getByTestId("conversation-row-ck-x")).toBeInTheDocument()
  })

  it("resolved conversations are hidden by default but shown after toggle", () => {
    mockEnriched = [
      {
        session: makeSession("s1", "ck-resolved", 1000),
        override: makeOverride("ck-resolved", { status: "resolved" }),
        unreadCount: 0,
      },
    ]
    render(<ConversationList />)
    expect(screen.queryByTestId("conversation-row-ck-resolved")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("conversation-list-toggle-resolved"))
    expect(screen.getByTestId("conversation-row-ck-resolved")).toBeInTheDocument()
  })

  it("pending filter chip shows only pending conversations", () => {
    mockEnriched = [
      { session: makeSession("s1", "ck-plain", 1000), override: undefined, unreadCount: 0 },
      {
        session: makeSession("s2", "ck-pending", 2000),
        override: makeOverride("ck-pending", { status: "pending" }),
        unreadCount: 0,
      },
    ]
    render(<ConversationList />)
    fireEvent.click(screen.getByTestId("conversation-filter-pending"))
    expect(screen.queryByTestId("conversation-row-ck-plain")).not.toBeInTheDocument()
    expect(screen.getByTestId("conversation-row-ck-pending")).toBeInTheDocument()
  })
})
