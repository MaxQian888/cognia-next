/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/settings",
  redirect: jest.fn(),
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

jest.mock("@/lib/db/schema", () => ({ getDb: jest.fn() }))

import type { AdapterInstanceRow, ConversationOverrideRow } from "@/lib/db/connector-types"

interface AdapterStats {
  adapter: AdapterInstanceRow
  total: number
  unread: number
  pinned: number
  archived: number
}

let mockStats: AdapterStats[] | undefined = []

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: jest.fn().mockImplementation(() => mockStats),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAdapter(id: string, displayName: string): AdapterInstanceRow {
  return {
    id,
    type: "telegram",
    displayName,
    enabled: true,
    transportMode: "polling",
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

import { InboxTab } from "./inbox-tab"

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("InboxTab", () => {
  beforeEach(() => {
    mockStats = []
  })

  it("shows empty state when no adapters configured", () => {
    mockStats = []
    render(<InboxTab />)
    expect(screen.getByText(/no adapters configured yet/i)).toBeInTheDocument()
  })

  it("renders a stats card for each adapter", () => {
    mockStats = [
      { adapter: makeAdapter("a1", "Telegram Bot"), total: 5, unread: 2, pinned: 1, archived: 0 },
      { adapter: makeAdapter("a2", "Discord Bot"), total: 3, unread: 0, pinned: 0, archived: 1 },
    ]
    render(<InboxTab />)
    expect(screen.getByTestId("inbox-stat-a1")).toBeInTheDocument()
    expect(screen.getByTestId("inbox-stat-a2")).toBeInTheDocument()
  })

  it("shows correct totals in each stats card", () => {
    mockStats = [{ adapter: makeAdapter("a1", "Bot"), total: 7, unread: 3, pinned: 2, archived: 1 }]
    render(<InboxTab />)
    expect(screen.getByTestId("total-a1")).toHaveTextContent("7")
    expect(screen.getByTestId("unread-a1")).toHaveTextContent("3")
    expect(screen.getByTestId("pinned-a1")).toHaveTextContent("2")
    expect(screen.getByTestId("archived-a1")).toHaveTextContent("1")
  })

  it("renders Open Inbox link to /inbox", () => {
    mockStats = []
    render(<InboxTab />)
    expect(screen.getByTestId("open-inbox-link")).toHaveAttribute("href", "/inbox")
  })
})
