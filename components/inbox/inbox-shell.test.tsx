/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"

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
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, replace: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/inbox/all",
  redirect: jest.fn(),
}))

// ADR-0131 §2.2 — the shell swaps itself for `StateCard.RequiresHost` when
// this shell can neither run connectors nor relay to a host.
jest.mock("@/lib/connectors/inbox-writes", () => ({ useInboxWriteRoute: jest.fn(() => "local") }))
jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  isTauri: jest.fn(() => false),
}))

const mockSetPreview = jest.fn()
const mockSetGrouping = jest.fn()
let mockPreview: string | null = null
jest.mock("@/hooks/inbox/use-inbox-url-state", () => ({
  useInboxUrlState: () => ({
    grouping: "status",
    previewSessionId: mockPreview,
    filters: [],
    setGrouping: mockSetGrouping,
    setPreview: mockSetPreview,
    toggleFilter: jest.fn(),
    clearFilters: jest.fn(),
  }),
}))

const mockRetryRows = jest.fn()
let mockRows: unknown[] | undefined = []
let mockRowsError: Error | null = null
jest.mock("@/hooks/inbox/use-conversation-rows", () => ({
  useConversationRows: (scope: unknown) => {
    mockRowsScope(scope)
    return { rows: mockRows, error: mockRowsError, retry: mockRetryRows }
  },
}))
const mockRowsScope = jest.fn()
const mockRetryAdapters = jest.fn()
let mockAdaptersError: Error | null = null
jest.mock("@/hooks/inbox/use-inbox-adapters", () => ({
  useInboxAdapters: () => ({ adapters: [], error: mockAdaptersError, retry: mockRetryAdapters }),
}))

// The panes have their own suites; here they are stubs that expose what the
// shell hands them.
jest.mock("./conversation-list", () => ({
  ConversationList: (props: {
    rows?: unknown[]
    error?: Error | null
    selectionMode: string
    selectedSessionId?: string | null
    onSelectSession: (row: unknown) => void
    onOpenSession: (row: unknown) => void
    onClearPreview?: () => void
    onPreviewSession?: (row: unknown) => void
    touchSelecting?: boolean
    onTouchSelectingChange?: (selecting: boolean) => void
  }) => (
    <div
      data-testid="list-stub"
      data-selection-mode={props.selectionMode}
      data-selected={props.selectedSessionId ?? ""}
      data-error={props.error?.message ?? ""}
      data-touch-selecting={String(Boolean(props.touchSelecting))}
    >
      <button type="button" onClick={() => props.onClearPreview?.()}>
        clear-preview
      </button>
      <button type="button" onClick={() => props.onPreviewSession?.(ROW)}>
        sheet-preview
      </button>
      <button type="button" onClick={() => props.onTouchSelectingChange?.(false)}>
        finish-selection
      </button>
      <button type="button" onClick={() => props.onSelectSession(ROW)}>
        select-row
      </button>
      <button type="button" onClick={() => props.onOpenSession(ROW)}>
        open-row
      </button>
    </div>
  ),
}))
jest.mock("./inbox-sidebar", () => {
  // Both exports share one stub so the desktop pane and the off-canvas sheet
  // are held to the same prop contract, including the adapter-error arm.
  const SidebarStub = (props: {
    view: string
    grouping: string
    adaptersError?: Error | null
    onRetryAdapters?: () => void
  }) => (
    <div
      data-testid="sidebar-stub"
      data-view={props.view}
      data-grouping={props.grouping}
      data-adapters-error={props.adaptersError?.message ?? ""}
    >
      <button type="button" onClick={() => props.onRetryAdapters?.()}>
        retry-adapters
      </button>
    </div>
  )
  return { InboxSidebar: SidebarStub, InboxSidebarContent: SidebarStub }
})
jest.mock("./triage/triage-preview-pane", () => ({
  TriagePreviewPane: (props: {
    sessionId: string | null
    summary?: { total: number }
    onClose: () => void
    onOpenInChat: (c: unknown) => void
  }) => (
    <div
      data-testid="triage-stub"
      data-session-id={props.sessionId ?? ""}
      data-total={props.summary?.total ?? ""}
    >
      <button type="button" onClick={props.onClose}>
        close-preview
      </button>
      <button
        type="button"
        onClick={() => props.onOpenInChat({ conversationKey: "lark:a1:oc", session: { id: "s1" } })}
      >
        reply-in-chat
      </button>
    </div>
  ),
}))
jest.mock("./triage/triage-preview-drawer", () => ({
  TriagePreviewDrawer: (props: {
    target: { sessionId: string; conversationKey: string; title: string } | null
    onClose: () => void
    onOpenInChat: (conversationKey: string, sessionId: string) => void
  }) =>
    props.target ? (
      <div
        data-testid="drawer-stub"
        data-session-id={props.target.sessionId}
        data-title={props.target.title}
      >
        <button type="button" onClick={props.onClose}>
          close-drawer
        </button>
        <button
          type="button"
          onClick={() => props.onOpenInChat(props.target!.conversationKey, props.target!.sessionId)}
        >
          drawer-reply
        </button>
      </div>
    ) : null,
}))
jest.mock("./notices/notice-area", () => ({
  InboxNoticeArea: ({
    conversationKey,
    suppressKinds,
  }: {
    conversationKey?: string
    suppressKinds?: string[]
  }) => (
    <div
      data-testid="inbox-notice-area-stub"
      data-conversation-key={conversationKey ?? ""}
      data-suppress={(suppressKinds ?? []).join(",")}
    />
  ),
}))

const mockBreakpoint = jest.fn().mockReturnValue("desktop")
jest.mock("@/hooks/ui", () => ({
  useBreakpoint: () => mockBreakpoint(),
  useIsMobile: () => mockBreakpoint() === "mobile",
}))

const mockWriteRoute = // eslint-disable-next-line @typescript-eslint/no-require-imports
  (require("@/lib/connectors/inbox-writes") as { useInboxWriteRoute: jest.Mock }).useInboxWriteRoute
// eslint-disable-next-line @typescript-eslint/no-require-imports
const mockIsTauri = (require("@/lib/platform/detect") as { isTauri: jest.Mock }).isTauri

jest.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="resizable-group">{children}</div>
  ),
  ResizablePanel: ({
    children,
    className,
    defaultSize,
    minSize,
    maxSize,
    ...rest
  }: {
    children: React.ReactNode
    className?: string
    defaultSize?: number | string
    minSize?: number | string
    maxSize?: number | string
    [k: string]: unknown
  }) => (
    <div
      className={className}
      data-testid={rest["data-testid"] as string}
      data-default-size={defaultSize === undefined ? undefined : String(defaultSize)}
      data-min-size={minSize === undefined ? undefined : String(minSize)}
      data-max-size={maxSize === undefined ? undefined : String(maxSize)}
    >
      {children}
    </div>
  ),
  ResizableHandle: () => <div data-testid="resizable-handle" />,
}))

jest.mock("@/components/ui/sidebar", () => ({
  SidebarProvider: ({
    children,
    className,
    defaultOpen,
  }: {
    children: React.ReactNode
    className?: string
    defaultOpen?: boolean
  }) => (
    <div
      data-testid="sidebar-provider"
      className={className}
      data-default-open={defaultOpen === undefined ? "" : String(defaultOpen)}
    >
      {children}
    </div>
  ),
  SidebarInset: ({ children, ...rest }: { children?: React.ReactNode; [k: string]: unknown }) => (
    <main {...rest}>{children}</main>
  ),
}))

const ROW = {
  session: {
    id: "s1",
    platformBinding: { conversationKey: "lark:a1:oc", adapterId: "a1", platform: "lark" },
  },
  override: undefined,
  unreadCount: 0,
}

import { InboxShell } from "./inbox-shell"

beforeEach(() => {
  mockBreakpoint.mockReturnValue("desktop")
  mockWriteRoute.mockReturnValue("local")
  mockIsTauri.mockReturnValue(false)
  mockPreview = null
  mockRows = []
  mockRowsError = null
  mockAdaptersError = null
  mockRetryAdapters.mockReset()
  mockPush.mockReset()
  mockSetPreview.mockReset()
  mockRowsScope.mockReset()
})

describe("InboxShell", () => {
  describe("requires-host state", () => {
    it.each(["desktop", "tablet", "mobile"])(
      "replaces the whole shell on %s when nothing can execute a write",
      (bp) => {
        mockBreakpoint.mockReturnValue(bp)
        mockWriteRoute.mockReturnValue("unavailable")
        render(<InboxShell view="all" />)
        expect(screen.getByTestId("inbox-requires-host")).toBeInTheDocument()
        expect(screen.queryByTestId("inbox-conversation-list-pane")).not.toBeInTheDocument()
      }
    )

    it("never shows it on the desktop, where `unavailable` just means still booting", () => {
      mockIsTauri.mockReturnValue(true)
      mockWriteRoute.mockReturnValue("unavailable")
      render(<InboxShell view="all" />)
      expect(screen.queryByTestId("inbox-requires-host")).not.toBeInTheDocument()
    })

    it("adds no safe-area insets when embedded", () => {
      mockWriteRoute.mockReturnValue("unavailable")
      render(<InboxShell view="all" embedded />)
      expect(screen.getByTestId("inbox-requires-host")).not.toHaveClass("safe-area-pt")
    })
  })

  describe("data", () => {
    it("scopes the rows to the route", () => {
      render(<InboxShell view="by-adapter" adapterId="a1" />)
      expect(mockRowsScope).toHaveBeenCalledWith({ adapterId: "a1", platformKind: undefined })
    })

    it("hands a failed read to the list instead of throwing past the panes", () => {
      mockRowsError = new Error("TransactionInactiveError")
      render(<InboxShell view="all" />)
      expect(screen.getByTestId("list-stub")).toHaveAttribute(
        "data-error",
        "TransactionInactiveError"
      )
      expect(screen.getByTestId("triage-stub")).toBeInTheDocument()
    })

    it("hands a failed adapter read and its retry to the sidebar", () => {
      mockAdaptersError = new Error("adapters unavailable")
      render(<InboxShell view="all" />)
      const sidebar = screen.getByTestId("sidebar-stub")
      expect(sidebar).toHaveAttribute("data-adapters-error", "adapters unavailable")
      fireEvent.click(screen.getByText("retry-adapters"))
      expect(mockRetryAdapters).toHaveBeenCalledTimes(1)
      // The adapter failure is the sidebar's to show; the list keeps rendering.
      expect(screen.getByTestId("list-stub")).toHaveAttribute("data-error", "")
    })

    it("passes no adapter error to the sidebar when the read succeeds", () => {
      render(<InboxShell view="all" />)
      expect(screen.getByTestId("sidebar-stub")).toHaveAttribute("data-adapters-error", "")
    })

    it("summarizes the rows for the triage empty state", () => {
      mockRows = [ROW, { ...ROW, session: { ...ROW.session, id: "s2" } }]
      render(<InboxShell view="all" />)
      expect(screen.getByTestId("triage-stub")).toHaveAttribute("data-total", "2")
    })
  })

  describe("preview selection", () => {
    it("uses preview mode on desktop and selects through the URL", () => {
      render(<InboxShell view="all" />)
      expect(screen.getByTestId("list-stub")).toHaveAttribute("data-selection-mode", "preview")
      fireEvent.click(screen.getByText("select-row"))
      expect(mockSetPreview).toHaveBeenCalledWith("s1")
      expect(mockPush).not.toHaveBeenCalled()
    })

    it("opens the exact session in chat", () => {
      render(<InboxShell view="all" />)
      fireEvent.click(screen.getByText("open-row"))
      expect(mockPush).toHaveBeenCalledWith("/inbox/c?key=lark%3Aa1%3Aoc&sessionId=s1")
    })

    it("shows the previewed session and suppresses the duplicate draft notice", () => {
      mockPreview = "s1"
      mockRows = [ROW]
      render(<InboxShell view="all" />)
      expect(screen.getByTestId("triage-stub")).toHaveAttribute("data-session-id", "s1")
      expect(screen.getByTestId("list-stub")).toHaveAttribute("data-selected", "s1")
      const notices = screen.getByTestId("inbox-notice-area-stub")
      expect(notices).toHaveAttribute("data-conversation-key", "lark:a1:oc")
      expect(notices).toHaveAttribute("data-suppress", "draft")
    })

    it("lets the keyboard's Escape clear the preview through the URL", () => {
      render(<InboxShell view="all" />)
      fireEvent.click(screen.getByText("clear-preview"))
      expect(mockSetPreview).toHaveBeenCalledWith(null)
    })

    it("closes the preview and replies in chat from the pane", () => {
      mockPreview = "s1"
      render(<InboxShell view="all" />)
      fireEvent.click(screen.getByText("close-preview"))
      expect(mockSetPreview).toHaveBeenCalledWith(null)
      fireEvent.click(screen.getByText("reply-in-chat"))
      expect(mockPush).toHaveBeenCalledWith("/inbox/c?key=lark%3Aa1%3Aoc&sessionId=s1")
    })

    it("shows the route's own detail content until something is previewed", () => {
      render(
        <InboxShell view="drafts">
          <div data-testid="draft-center-stub" />
        </InboxShell>
      )
      expect(screen.getByTestId("draft-center-stub")).toBeInTheDocument()
      expect(screen.queryByTestId("triage-stub")).not.toBeInTheDocument()
    })

    it("lets a preview replace the route's detail content", () => {
      mockPreview = "s1"
      render(
        <InboxShell view="drafts">
          <div data-testid="draft-center-stub" />
        </InboxShell>
      )
      expect(screen.queryByTestId("draft-center-stub")).not.toBeInTheDocument()
      expect(screen.getByTestId("triage-stub")).toBeInTheDocument()
    })

    it("hands the sidebar the active route and the grouping in force", () => {
      render(<InboxShell view="drafts" />)
      expect(screen.getByTestId("sidebar-stub")).toHaveAttribute("data-view", "drafts")
      expect(screen.getByTestId("sidebar-stub")).toHaveAttribute("data-grouping", "status")
    })
  })

  describe("desktop", () => {
    it("renders a resizable three-pane group with the page header", () => {
      render(<InboxShell view="all" />)
      expect(screen.getByTestId("resizable-group")).toBeInTheDocument()
      expect(screen.getByTestId("inbox-sidebar-pane")).toBeInTheDocument()
      expect(screen.getByTestId("inbox-conversation-list-pane")).toBeInTheDocument()
      expect(screen.getByTestId("inbox-detail-pane")).toBeInTheDocument()
      expect(screen.getByTestId("inbox-header")).toBeInTheDocument()
    })

    it("passes percent-string sizes to every resizable panel", () => {
      render(<InboxShell view="all" />)
      for (const id of [
        "inbox-sidebar-pane",
        "inbox-conversation-list-pane",
        "inbox-detail-pane",
      ]) {
        expect(screen.getByTestId(id).getAttribute("data-default-size")).toMatch(/%$/)
      }
    })
  })

  describe("tablet", () => {
    beforeEach(() => mockBreakpoint.mockReturnValue("tablet"))

    it("shows the list at w-72 beside the triage pane, sidebar off-canvas", () => {
      render(<InboxShell view="all" />)
      const list = screen.getByTestId("inbox-conversation-list-pane")
      expect(list).toHaveClass("md:w-72", "border-e")
      expect(screen.getByTestId("inbox-detail-pane")).toBeInTheDocument()
      expect(screen.getByTestId("sidebar-provider")).toHaveAttribute("data-default-open", "false")
      expect(screen.getByTestId("list-stub")).toHaveAttribute("data-selection-mode", "preview")
      expect(screen.queryByTestId("inbox-header")).not.toBeInTheDocument()
    })
  })

  describe("mobile", () => {
    beforeEach(() => mockBreakpoint.mockReturnValue("mobile"))

    it("shows the list only, and a tap opens the chat", () => {
      mockPreview = "s1"
      render(<InboxShell view="all" />)
      expect(screen.getByTestId("inbox-conversation-list-pane")).toBeInTheDocument()
      expect(screen.queryByTestId("inbox-detail-pane")).not.toBeInTheDocument()
      // A stale `?preview=` from a wider window does not select anything here.
      expect(screen.getByTestId("list-stub")).toHaveAttribute("data-selection-mode", "open")
      expect(screen.getByTestId("list-stub")).toHaveAttribute("data-selected", "")
    })

    it("applies the safe-area insets standalone but not when embedded", () => {
      const { unmount } = render(<InboxShell view="all" />)
      expect(screen.getByTestId("sidebar-provider")).toHaveClass("safe-area-pt", "safe-area-pb")
      unmount()
      render(<InboxShell view="all" embedded />)
      expect(screen.getByTestId("sidebar-provider")).not.toHaveClass("safe-area-pt")
      expect(screen.getByTestId("sidebar-provider")).not.toHaveClass("safe-area-pb")
    })

    it("previews a row in the drawer from the action sheet, and replies from it", () => {
      render(<InboxShell view="all" />)
      expect(screen.queryByTestId("drawer-stub")).not.toBeInTheDocument()
      fireEvent.click(screen.getByText("sheet-preview"))
      const drawer = screen.getByTestId("drawer-stub")
      expect(drawer).toHaveAttribute("data-session-id", "s1")
      // An untitled session is named by its conversation key.
      expect(drawer).toHaveAttribute("data-title", "lark:a1:oc")
      fireEvent.click(screen.getByText("drawer-reply"))
      expect(mockPush).toHaveBeenCalledWith(expect.stringContaining("/inbox/c"))
      expect(screen.queryByTestId("drawer-stub")).not.toBeInTheDocument()
    })

    it("closes the drawer", () => {
      render(<InboxShell view="all" />)
      fireEvent.click(screen.getByText("sheet-preview"))
      fireEvent.click(screen.getByText("close-drawer"))
      expect(screen.queryByTestId("drawer-stub")).not.toBeInTheDocument()
    })

    it("passes the host's selection mode through to the list", () => {
      const onTouchSelectingChange = jest.fn()
      render(
        <InboxShell
          view="all"
          embedded
          touchSelecting
          onTouchSelectingChange={onTouchSelectingChange}
        />
      )
      expect(screen.getByTestId("list-stub")).toHaveAttribute("data-touch-selecting", "true")
      fireEvent.click(screen.getByText("finish-selection"))
      expect(onTouchSelectingChange).toHaveBeenCalledWith(false)
    })

    describe("selectable report", () => {
      // The phone host hides its "Select" toggle on `false`, so every arm that
      // leaves nothing to check must report it, not just the empty list.
      it("reports false when no host can serve the list off the desktop", () => {
        mockWriteRoute.mockReturnValue("unavailable")
        mockRows = [ROW]
        const onSelectableChange = jest.fn()
        render(<InboxShell view="all" embedded onSelectableChange={onSelectableChange} />)
        expect(screen.getByTestId("inbox-requires-host")).toBeInTheDocument()
        expect(onSelectableChange).toHaveBeenLastCalledWith(false)
        expect(onSelectableChange).not.toHaveBeenCalledWith(true)
      })

      it("reports false for an empty list and while rows are still loading", () => {
        const onSelectableChange = jest.fn()
        const { unmount } = render(
          <InboxShell view="all" embedded onSelectableChange={onSelectableChange} />
        )
        expect(onSelectableChange).toHaveBeenLastCalledWith(false)
        unmount()

        mockRows = undefined
        onSelectableChange.mockClear()
        render(<InboxShell view="all" embedded onSelectableChange={onSelectableChange} />)
        expect(onSelectableChange).toHaveBeenLastCalledWith(false)
        expect(onSelectableChange).not.toHaveBeenCalledWith(true)
      })

      it("reports true once rows exist", () => {
        const onSelectableChange = jest.fn()
        const { rerender } = render(
          <InboxShell view="all" embedded onSelectableChange={onSelectableChange} />
        )
        expect(onSelectableChange).toHaveBeenLastCalledWith(false)

        mockRows = [ROW]
        rerender(<InboxShell view="all" embedded onSelectableChange={onSelectableChange} />)
        expect(onSelectableChange).toHaveBeenLastCalledWith(true)
      })
    })
  })

  it("never turns on touch selection off the phone", () => {
    render(<InboxShell view="all" touchSelecting />)
    expect(screen.getByTestId("list-stub")).toHaveAttribute("data-touch-selecting", "false")
    expect(screen.queryByTestId("drawer-stub")).not.toBeInTheDocument()
  })
})
