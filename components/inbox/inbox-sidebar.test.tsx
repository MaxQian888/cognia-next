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

function makeAdapter(
  id: string,
  displayName: string,
  type: AdapterInstanceRow["type"] = "telegram"
): AdapterInstanceRow {
  return {
    id,
    type,
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

import { InboxSidebar, platformsOfAdapters, type InboxSidebarProps } from "./inbox-sidebar"

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const mockGroupingChange = jest.fn()

function renderSidebar(props: Partial<InboxSidebarProps> = {}) {
  return render(
    <InboxSidebar
      view="all"
      grouping="status"
      onGroupingChange={mockGroupingChange}
      adapters={mockQueryResult as AdapterInstanceRow[]}
      {...props}
    />
  )
}

describe("InboxSidebar", () => {
  beforeEach(() => {
    mockQueryResult = []
    mockRecentByAdapter.clear()
    mockReplace.mockReset()
    mockPush.mockReset()
    mockGroupingChange.mockReset()
    mockUseLiveQuery.mockClear()
  })

  describe("grouping toggle", () => {
    it("renders one chip per grouping", () => {
      renderSidebar()
      expect(screen.getByTestId("group-chip-status")).toBeInTheDocument()
      expect(screen.getByTestId("group-chip-adapter")).toBeInTheDocument()
      expect(screen.getByTestId("group-chip-platform")).toBeInTheDocument()
    })

    it("marks the grouping in force", () => {
      renderSidebar({ grouping: "platform" })
      expect(screen.getByTestId("group-chip-platform")).toHaveAttribute("data-state", "on")
      expect(screen.getByTestId("group-chip-status")).toHaveAttribute("data-state", "off")
    })

    it("reports a new grouping instead of writing a param nobody reads", () => {
      renderSidebar()
      fireEvent.click(screen.getByTestId("group-chip-platform"))
      expect(mockGroupingChange).toHaveBeenCalledWith("platform")
      expect(mockReplace).not.toHaveBeenCalled()
    })

    it("ignores a click on the active chip (Radix reports an empty value)", () => {
      renderSidebar({ grouping: "adapter" })
      fireEvent.click(screen.getByTestId("group-chip-adapter"))
      expect(mockGroupingChange).not.toHaveBeenCalled()
    })
  })

  describe("destinations", () => {
    it("marks All conversations active on /inbox/all", () => {
      renderSidebar({ view: "all" })
      expect(screen.getByRole("link", { name: "All conversations" })).toHaveAttribute(
        "aria-current",
        "page"
      )
      expect(screen.getByRole("link", { name: "Drafts" })).not.toHaveAttribute("aria-current")
    })

    it("marks Drafts active on /inbox/drafts", () => {
      renderSidebar({ view: "drafts" })
      expect(screen.getByRole("link", { name: "Drafts" })).toHaveAttribute("aria-current", "page")
      expect(screen.getByRole("link", { name: "All conversations" })).not.toHaveAttribute(
        "aria-current"
      )
    })
  })

  describe("adapters", () => {
    it("shows a skeleton while the adapters load, not the empty state", () => {
      renderSidebar({ adapters: undefined })
      expect(screen.getByTestId("inbox-adapters-loading")).toHaveAttribute("aria-busy", "true")
      expect(screen.queryByText("No adapters configured")).not.toBeInTheDocument()
    })

    it("shows a failed adapters read with a retry", () => {
      const onRetryAdapters = jest.fn()
      renderSidebar({ adapters: undefined, adaptersError: new Error("db closed"), onRetryAdapters })
      expect(screen.getByTestId("inbox-adapters-error")).toHaveTextContent("db closed")
      fireEvent.click(screen.getByRole("button", { name: /retry/i }))
      expect(onRetryAdapters).toHaveBeenCalled()
    })

    it("shows the empty state once loaded with none", () => {
      renderSidebar({ adapters: [] })
      expect(screen.getByText("No adapters configured")).toBeInTheDocument()
    })

    it("shows a section for each enabled adapter", () => {
      mockQueryResult = [makeAdapter("a1", "Bot Alpha"), makeAdapter("a2", "Bot Beta")]
      renderSidebar()
      expect(screen.getByTestId("adapter-section-a1")).toBeInTheDocument()
      expect(screen.getByTestId("adapter-section-a2")).toBeInTheDocument()
      expect(screen.getByText("Bot Alpha")).toBeInTheDocument()
      expect(screen.getByText("Bot Beta")).toBeInTheDocument()
    })

    it("marks the scoped adapter as the current page", () => {
      mockQueryResult = [makeAdapter("a1", "Bot Alpha"), makeAdapter("a2", "Bot Beta")]
      renderSidebar({ view: "by-adapter", activeAdapterId: "a2" })
      expect(screen.getByTestId("adapter-section-a2")).toHaveAttribute("aria-current", "page")
      expect(screen.getByTestId("adapter-section-a1")).not.toHaveAttribute("aria-current")
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
      renderSidebar()
      expect(screen.queryByTestId("adapter-section-recent-a1")).not.toBeInTheDocument()
      fireEvent.click(screen.getByTestId("adapter-section-toggle-a1"))
      expect(screen.getByTestId("adapter-section-recent-a1")).toBeInTheDocument()
      expect(screen.getByText("Hello world")).toBeInTheDocument()
      // Recent links name the exact session: several can share one key.
      expect(screen.getByTestId("adapter-recent-a1-s1")).toHaveAttribute(
        "href",
        "/inbox/c?key=ck1&sessionId=s1"
      )
    })

    it("expanded section shows empty placeholder when no sessions", () => {
      mockQueryResult = [makeAdapter("a1", "Bot Alpha")]
      mockRecentByAdapter.set("a1", [])
      renderSidebar()
      fireEvent.click(screen.getByTestId("adapter-section-toggle-a1"))
      expect(screen.getByText("No conversations yet")).toBeInTheDocument()
    })

    it("chevron toggle does NOT trigger navigation", () => {
      mockQueryResult = [makeAdapter("a1", "Bot Alpha")]
      renderSidebar()
      fireEvent.click(screen.getByTestId("adapter-section-toggle-a1"))
      expect(mockPush).not.toHaveBeenCalled()
    })

    it("clicking the row body navigates to the adapter scope", () => {
      mockQueryResult = [makeAdapter("a1", "Bot Alpha")]
      renderSidebar()
      fireEvent.click(screen.getByTestId("adapter-section-a1"))
      expect(mockPush).toHaveBeenCalledWith("/inbox/adapter?adapterId=a1")
    })

    it("expand toggle is a labelled disclosure control", () => {
      mockQueryResult = [makeAdapter("a1", "Bot Alpha")]
      renderSidebar()
      const toggle = screen.getByTestId("adapter-section-toggle-a1")
      expect(toggle.tagName).toBe("BUTTON")
      expect(toggle).toHaveAttribute("aria-expanded", "false")
      expect(toggle).toHaveAccessibleName(/Bot Alpha/i)
      fireEvent.click(toggle)
      expect(screen.getByTestId("adapter-section-toggle-a1")).toHaveAttribute(
        "aria-expanded",
        "true"
      )
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
      renderSidebar()
      fireEvent.click(screen.getByTestId("adapter-section-toggle-a1"))
      const sizedNode = screen.getByTestId("adapter-recent-a1-s1").closest(".min-h-11")
      expect(sizedNode).not.toBeNull()
      expect(sizedNode).toHaveClass("md:h-7")
      expect(sizedNode).toHaveClass("md:min-h-0")
    })
  })

  describe("platform grouping", () => {
    it("lists each platform once, linking to its scoped route", () => {
      mockQueryResult = [
        makeAdapter("a1", "Bot Alpha", "lark"),
        makeAdapter("a2", "Bot Beta", "telegram"),
        makeAdapter("a3", "Bot Gamma", "lark"),
      ]
      renderSidebar({ grouping: "platform" })
      expect(screen.getByText("Platforms")).toBeInTheDocument()
      expect(screen.getByRole("link", { name: "Lark" })).toHaveAttribute(
        "href",
        "/inbox/platform?kind=lark"
      )
      expect(screen.getByRole("link", { name: "Telegram" })).toHaveAttribute(
        "href",
        "/inbox/platform?kind=telegram"
      )
      expect(screen.queryByTestId("adapter-section-a1")).not.toBeInTheDocument()
    })

    it("marks the scoped platform as the current page", () => {
      mockQueryResult = [makeAdapter("a1", "Bot Alpha", "lark")]
      renderSidebar({ grouping: "platform", view: "by-platform", activePlatformKind: "lark" })
      expect(screen.getByRole("link", { name: "Lark" })).toHaveAttribute("aria-current", "page")
    })

    it("derives platforms in first-seen order without duplicates", () => {
      expect(
        platformsOfAdapters([
          makeAdapter("a", "x", "slack"),
          makeAdapter("b", "y", "lark"),
          makeAdapter("c", "z", "slack"),
        ])
      ).toEqual(["slack", "lark"])
    })
  })
})
