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

jest.mock("@/components/ui/sidebar", () => ({
  Sidebar: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="sidebar">{children}</div>
  ),
  SidebarContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarGroupLabel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SidebarMenu: ({ children }: { children: React.ReactNode }) => <ul>{children}</ul>,
  SidebarMenuButton: ({
    children,
    onClick,
    ...rest
  }: {
    children: React.ReactNode
    onClick?: () => void
    [k: string]: unknown
  }) => (
    <button onClick={onClick} {...rest}>
      {children}
    </button>
  ),
  SidebarMenuItem: ({ children }: { children: React.ReactNode }) => <li>{children}</li>,
}))

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

    expect(mockPush).toHaveBeenCalledWith("/inbox/adapter/a1")
  })
})
