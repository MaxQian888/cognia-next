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

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: jest.fn().mockImplementation(() => mockQueryResult),
}))

jest.mock("@/lib/db/schema", () => ({ getDb: jest.fn() }))

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
    mockReplace.mockReset()
    mockPush.mockReset()
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
})
