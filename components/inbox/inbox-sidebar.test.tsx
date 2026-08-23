/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockReplace = jest.fn()
const mockPush = jest.fn()

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/inbox",
  redirect: jest.fn(),
}))

let mockQueryResult: unknown[] = []
// Per-adapter recent-sessions overrides. Keyed by adapter.id; falls back to []
// when the adapter id isn't pre-seeded. Distinguished from `mockQueryResult`
// (which holds the adapter LIST) by the deps array: the adapters query uses
// `[]` deps; the recent-sessions query uses `[expanded, adapter.id]` deps.
const mockRecentByAdapter = new Map<string, unknown[]>()

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: jest.fn().mockImplementation((_queryFn: unknown, deps?: unknown[]) => {
    // No deps (or empty deps) → the top-level adapter list query.
    if (!deps || deps.length === 0) return mockQueryResult
    // Otherwise deps = [expanded, adapterId] from AdapterSection.
    const adapterId = deps[1]
    if (typeof adapterId === "string") {
      return mockRecentByAdapter.get(adapterId) ?? []
    }
    return []
  }),
}))

import { useLiveQuery as _useLiveQuery } from "dexie-react-hooks"
const mockUseLiveQuery = _useLiveQuery as jest.Mock

jest.mock("@/lib/db/schema", () => ({ getDb: jest.fn() }))

// Drafts badge subscriber — isolate the sidebar from the draft queue.
jest.mock("@/hooks/connectors/use-pending-drafts", () => ({
  usePendingDrafts: () => [],
}))

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({
    children,
    href,
    ...rest
  }: {
    children: React.ReactNode
    href: string
    [k: string]: unknown
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

// The shared manual mock, not a local factory: `AdapterSection` now uses
// `SidebarMenuAction` / `SidebarMenuSub` / `SidebarMenuSubItem` /
// `SidebarMenuSubButton` / `SidebarMenuBadge`, and an inline factory has to be
// extended every time the component reaches for another primitive.
jest.mock("@/components/ui/sidebar")

// Tooltip primitives are mocked as passthroughs — the real Radix tooltip
// requires a portal + provider that adds complexity without value in unit
// tests. We only need the trigger child to render and receive its props.
jest.mock("@/components/ui/tooltip")

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

import type { AdapterInstanceRow } from "@/lib/db/connector-types"

function makeAdapter(id: string, displayName: string): AdapterInstanceRow {
  return {
    id,
    type: "telegram",
    displayName,
    enabled: true,
    transportMode: "stub",
    settings: {},
    credentialsRef: { keyringService: "k", accounts: [] },
    trigger: { rules: [], blockers: [], storeUnmatchedInDraftMode: false },
    defaultMode: "auto",
    mediaModelPolicy: "local_extract_only",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

// ---------------------------------------------------------------------------
// Subject
// ---------------------------------------------------------------------------

import { InboxSidebar } from "./inbox-sidebar"

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("InboxSidebar", () => {
  beforeEach(() => {
    mockQueryResult = []
    mockRecentByAdapter.clear()
    mockReplace.mockReset()
    mockPush.mockReset()
    mockUseLiveQuery.mockClear()
  })

  it("renders three view-mode chips", () => {
    render(<InboxSidebar view="by-adapter" />)

    expect(screen.getByTestId("view-chip-by-adapter")).toBeInTheDocument()
    expect(screen.getByTestId("view-chip-by-platform")).toBeInTheDocument()
    expect(screen.getByTestId("view-chip-unified")).toBeInTheDocument()
  })

  it("clicking a chip sets the view query param", () => {
    render(<InboxSidebar view="by-adapter" />)

    fireEvent.click(screen.getByTestId("view-chip-by-platform"))

    expect(mockReplace).toHaveBeenCalledWith(
      expect.stringContaining("view=by-platform"),
      expect.anything()
    )
  })

  it("shows a section for each enabled adapter", () => {
    mockQueryResult = [makeAdapter("a1", "Bot Alpha"), makeAdapter("a2", "Bot Beta")]

    render(<InboxSidebar view="by-adapter" />)

    expect(screen.getByTestId("adapter-section-a1")).toBeInTheDocument()
    expect(screen.getByTestId("adapter-section-a2")).toBeInTheDocument()
    expect(screen.getByText("Bot Alpha")).toBeInTheDocument()
    expect(screen.getByText("Bot Beta")).toBeInTheDocument()
  })

  it("shows empty state when no adapters configured", () => {
    mockQueryResult = []

    render(<InboxSidebar view="by-adapter" />)

    expect(screen.getByText("No adapters configured")).toBeInTheDocument()
  })

  it("toggling the chevron expands the recent-sessions list", () => {
    mockQueryResult = [makeAdapter("a1", "Bot Alpha")]
    mockRecentByAdapter.set("a1", [
      {
        id: "s1",
        title: "Hello world",
        platformBinding: { adapterId: "a1", conversationKey: "ck1" },
        updatedAt: 2000,
      },
      {
        id: "s2",
        title: "Catch-up",
        platformBinding: { adapterId: "a1", conversationKey: "ck2" },
        updatedAt: 1000,
      },
    ])

    render(<InboxSidebar view="by-adapter" />)
    expect(screen.queryByTestId("adapter-section-recent-a1")).not.toBeInTheDocument()

    fireEvent.click(screen.getByTestId("adapter-section-toggle-a1"))

    expect(screen.getByTestId("adapter-section-recent-a1")).toBeInTheDocument()
    expect(screen.getByText("Hello world")).toBeInTheDocument()
    expect(screen.getByText("Catch-up")).toBeInTheDocument()
  })

  it("expanded section shows empty placeholder when no sessions", () => {
    mockQueryResult = [makeAdapter("a1", "Bot Alpha")]
    mockRecentByAdapter.set("a1", [])

    render(<InboxSidebar view="by-adapter" />)
    fireEvent.click(screen.getByTestId("adapter-section-toggle-a1"))

    expect(screen.getByText("No conversations yet")).toBeInTheDocument()
  })

  it("chevron toggle does NOT trigger navigation", () => {
    mockQueryResult = [makeAdapter("a1", "Bot Alpha")]

    render(<InboxSidebar view="by-adapter" />)
    fireEvent.click(screen.getByTestId("adapter-section-toggle-a1"))

    // The chevron's onClick has stopPropagation; the row navigate should not fire.
    expect(mockPush).not.toHaveBeenCalled()
  })

  it("clicking the row body navigates to the adapter scope", () => {
    mockQueryResult = [makeAdapter("a1", "Bot Alpha")]

    render(<InboxSidebar view="by-adapter" />)
    fireEvent.click(screen.getByTestId("adapter-section-a1"))

    expect(mockPush).toHaveBeenCalledWith("/inbox/adapter?adapterId=a1")
  })

  // The toggle is `SidebarMenuAction` now rather than a hand-rolled 36px ghost
  // Button — the rail can be as narrow as ~123px at
  // `INBOX_LAYOUT_BOUNDS.sidebarMin`. (The shared sidebar mock strips
  // `data-slot`/variant props, so this pins the contract that survives it:
  // an accessible, labelled disclosure button.)
  it("expand toggle is a labelled disclosure control", () => {
    mockQueryResult = [makeAdapter("a1", "Bot Alpha")]

    render(<InboxSidebar view="by-adapter" />)
    const toggle = screen.getByTestId("adapter-section-toggle-a1")
    expect(toggle.tagName).toBe("BUTTON")
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    // Translated aria-label is interpolated with the adapter name (en.json mock).
    expect(toggle).toHaveAccessibleName(/Bot Alpha/i)

    fireEvent.click(toggle)
    expect(screen.getByTestId("adapter-section-toggle-a1")).toHaveAttribute("aria-expanded", "true")
  })

  it("nested recent-conversation links use responsive touch-target sizing", () => {
    mockQueryResult = [makeAdapter("a1", "Bot Alpha")]
    mockRecentByAdapter.set("a1", [
      {
        id: "s1",
        title: "Hello world",
        platformBinding: { adapterId: "a1", conversationKey: "ck1" },
        updatedAt: 2000,
      },
    ])

    render(<InboxSidebar view="by-adapter" />)
    fireEvent.click(screen.getByTestId("adapter-section-toggle-a1"))

    // The link is the `asChild` target of `SidebarMenuSubButton`, so the
    // sizing classes land on its parent button.
    const sizedNode = screen.getByTestId("adapter-recent-a1-s1").closest(".min-h-11")
    // 44px on mobile; md+ takes the primitive's own compact 28px.
    expect(sizedNode).not.toBeNull()
    expect(sizedNode).toHaveClass("md:h-7")
    expect(sizedNode).toHaveClass("md:min-h-0")
  })
})
