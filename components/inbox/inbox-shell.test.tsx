/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

// jsdom does not implement `window.matchMedia`; the command palette + motion
// hooks read it. Provide a permissive stub.
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

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/inbox",
  redirect: jest.fn(),
}))

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: jest.fn().mockReturnValue([]),
}))

jest.mock("@/lib/db/schema", () => ({ getDb: jest.fn() }))

// ADR-0131 §2.2 — the shell swaps itself for `StateCard.RequiresHost` when
// this shell can neither run connectors nor relay to a host.
jest.mock("@/lib/connectors/inbox-writes", () => ({ useInboxWriteRoute: jest.fn(() => "local") }))
// Partial mock: `detect` also exports `isCapacitor`, which the transport
// picker calls at import time — replacing the whole module breaks it.
jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  isTauri: jest.fn(() => false),
}))
// The sidebar header's view-mode toggles are tooltip-wrapped and always
// render now; `app/layout.tsx` supplies the provider in the real app.
jest.mock("@/components/ui/tooltip")
// The notice area owns six live queries against a stubbed `getDb()`. Its own
// contract is covered by `notices/notice-area.test.tsx`; here we only care
// that the shell mounts exactly one and forwards the conversation key.
jest.mock("./notices/notice-area", () => ({
  InboxNoticeArea: ({ conversationKey }: { conversationKey?: string }) => (
    <div data-testid="inbox-notice-area-stub" data-conversation-key={conversationKey ?? ""} />
  ),
}))

// Drive the breakpoint per test. `useIsMobile` is retained for any child that
// still consumes it.
const mockBreakpoint = jest.fn().mockReturnValue("desktop")

const mockWriteRoute = // eslint-disable-next-line @typescript-eslint/no-require-imports
  (require("@/lib/connectors/inbox-writes") as { useInboxWriteRoute: jest.Mock }).useInboxWriteRoute
// eslint-disable-next-line @typescript-eslint/no-require-imports
const mockIsTauri = (require("@/lib/platform/detect") as { isTauri: jest.Mock }).isTauri
jest.mock("@/hooks/ui", () => ({
  useBreakpoint: () => mockBreakpoint(),
  useIsMobile: () => mockBreakpoint() === "mobile",
}))

// Stub react-resizable-panels wrapper — the real Group measures the DOM which
// jsdom can't satisfy. Render panels as plain divs, forwarding test hooks.
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

// Sidebar primitives — stub to render children directly.
jest.mock("@/components/ui/sidebar", () => ({
  SidebarProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="sidebar-provider">{children}</div>
  ),
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
    isActive,
    ...rest
  }: {
    children: React.ReactNode
    onClick?: () => void
    isActive?: boolean
    [k: string]: unknown
  }) => (
    <button onClick={onClick} data-active={isActive} {...rest}>
      {children}
    </button>
  ),
  SidebarMenuItem: ({ children }: { children: React.ReactNode }) => <li>{children}</li>,
  SidebarInset: ({ children, ...rest }: { children?: React.ReactNode; [k: string]: unknown }) => (
    <main {...rest}>{children}</main>
  ),
  SidebarTrigger: () => <button>Toggle</button>,
}))

// ---------------------------------------------------------------------------
// Subject
// ---------------------------------------------------------------------------

import { InboxShell } from "./inbox-shell"

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("InboxShell", () => {
  beforeEach(() => {
    mockBreakpoint.mockReturnValue("desktop")
    mockWriteRoute.mockReturnValue("local")
    mockIsTauri.mockReturnValue(false)
  })

  // ── ADR-0131 §2.2: standalone shells cannot write ────────────────────────
  describe("requires-host state", () => {
    it.each(["desktop", "tablet", "mobile"])(
      "replaces the whole shell on %s when nothing can execute a write",
      (bp) => {
        // Showing the normal panes here would render an empty conversation
        // list ("you have no conversations" — a lie) plus reply controls that
        // silently do nothing.
        mockBreakpoint.mockReturnValue(bp)
        mockWriteRoute.mockReturnValue("unavailable")
        render(<InboxShell view="all" />)

        expect(screen.getByTestId("inbox-requires-host")).toBeInTheDocument()
        expect(screen.queryByTestId("inbox-conversation-list-pane")).not.toBeInTheDocument()
        expect(screen.queryByTestId("inbox-detail-pane")).not.toBeInTheDocument()
      }
    )

    it.each(["local", "remote"] as const)("renders the normal shell on route %s", (route) => {
      mockWriteRoute.mockReturnValue(route)
      render(<InboxShell view="all" />)
      expect(screen.queryByTestId("inbox-requires-host")).not.toBeInTheDocument()
      expect(screen.getByTestId("inbox-conversation-list-pane")).toBeInTheDocument()
    })

    it("never shows it on the desktop, where `unavailable` just means still booting", () => {
      // A Tauri window always ends up with a runtime (or drives a remote
      // host); flashing the pairing card during boot would be pure noise.
      mockIsTauri.mockReturnValue(true)
      mockWriteRoute.mockReturnValue("unavailable")
      render(<InboxShell view="all" />)
      expect(screen.queryByTestId("inbox-requires-host")).not.toBeInTheDocument()
      expect(screen.getByTestId("inbox-conversation-list-pane")).toBeInTheDocument()
    })
  })

  // The five notice strips used to mount from two different places — two here,
  // three from the `/inbox/c` route. Consolidating them means the shell is the
  // sole mount site, on every branch.
  describe("notice area", () => {
    it.each(["desktop", "tablet", "mobile"])("mounts exactly one on %s", (bp) => {
      mockBreakpoint.mockReturnValue(bp)
      render(<InboxShell view="all" />)
      expect(screen.getAllByTestId("inbox-notice-area-stub")).toHaveLength(1)
    })

    it("forwards the conversation key so conversation-scoped notices can mount", () => {
      render(<InboxShell view="conversation" conversationKey="lark:a1:oc_x" />)
      expect(screen.getByTestId("inbox-notice-area-stub")).toHaveAttribute(
        "data-conversation-key",
        "lark:a1:oc_x"
      )
    })

    it("passes no conversation key on the list routes", () => {
      render(<InboxShell view="all" />)
      expect(screen.getByTestId("inbox-notice-area-stub")).toHaveAttribute(
        "data-conversation-key",
        ""
      )
    })
  })

  describe("desktop", () => {
    it("renders a resizable three-pane group", () => {
      render(<InboxShell view="all" />)
      expect(screen.getByTestId("resizable-group")).toBeInTheDocument()
      expect(screen.getByTestId("inbox-sidebar-pane")).toBeInTheDocument()
      expect(screen.getByTestId("inbox-conversation-list-pane")).toBeInTheDocument()
      expect(screen.getByTestId("inbox-detail-pane")).toBeInTheDocument()
    })

    // react-resizable-panels v4 interprets bare numbers as PIXELS; sizes must
    // be percent strings or the three panes collapse to px-wide slivers.
    it("passes percent-string sizes to every resizable panel", () => {
      render(<InboxShell view="all" />)
      const percent = /^\d+(\.\d+)?%$/
      const sidebar = screen.getByTestId("inbox-sidebar-pane")
      const list = screen.getByTestId("inbox-conversation-list-pane")
      const detail = screen.getByTestId("inbox-detail-pane")
      for (const pane of [sidebar, list, detail]) {
        expect(pane.dataset.defaultSize).toMatch(percent)
        expect(pane.dataset.minSize).toMatch(percent)
      }
      expect(sidebar.dataset.maxSize).toMatch(percent)
      expect(list.dataset.maxSize).toMatch(percent)
    })

    it("renders children in the detail pane", () => {
      render(
        <InboxShell view="all">
          <div data-testid="child-content">Hello detail</div>
        </InboxShell>
      )
      expect(screen.getByTestId("child-content")).toBeInTheDocument()
    })

    it("shows placeholder text when no children", () => {
      render(<InboxShell view="all" />)
      expect(screen.getByText("Select a conversation to start")).toBeInTheDocument()
    })
  })

  describe("tablet", () => {
    beforeEach(() => mockBreakpoint.mockReturnValue("tablet"))

    it("uses the flex layout with responsive Tailwind widths", () => {
      render(<InboxShell view="all" />)
      const middle = screen.getByTestId("inbox-conversation-list-pane")
      expect(middle.className).toContain("w-full")
      expect(middle.className).toContain("md:w-64")
      expect(middle.className).toContain("lg:w-72")
    })

    it("uses the RTL-safe logical border (border-e, not border-r)", () => {
      render(<InboxShell view="all" />)
      const middle = screen.getByTestId("inbox-conversation-list-pane")
      expect(middle.className).toContain("border-e")
      expect(middle.className).not.toMatch(/(^|\s)border-r(\s|$)/)
    })

    it("renders both panes regardless of conversationKey", () => {
      render(<InboxShell view="conversation" conversationKey="ck1" />)
      const middle = screen.getByTestId("inbox-conversation-list-pane")
      const detail = screen.getByTestId("inbox-detail-pane")
      expect(middle.className).not.toMatch(/(^|\s)hidden(\s|$)/)
      expect(detail.className).not.toMatch(/(^|\s)hidden(\s|$)/)
    })
  })

  describe("mobile", () => {
    beforeEach(() => mockBreakpoint.mockReturnValue("mobile"))

    it("with no conversation key shows the list only", () => {
      render(<InboxShell view="all" />)
      const middle = screen.getByTestId("inbox-conversation-list-pane")
      const detail = screen.getByTestId("inbox-detail-pane")
      expect(middle.className).not.toMatch(/(^|\s)hidden(\s|$)/)
      expect(detail.className).toContain("hidden")
      expect(detail.className).toContain("md:flex")
    })

    it("with a conversation key shows the detail only", () => {
      render(<InboxShell view="conversation" conversationKey="ck-mobile" />)
      const middle = screen.getByTestId("inbox-conversation-list-pane")
      const detail = screen.getByTestId("inbox-detail-pane")
      expect(middle.className).toContain("hidden")
      expect(middle.className).toContain("md:flex")
      expect(detail.className).not.toMatch(/(^|\s)hidden(\s|$)/)
    })
  })
})

// Every other feature route mounts this band, and `/inbox` was the one that
// did not: no title, no page-level action slot, so it read as a different
// application from `/scheduler` beside it.
describe("InboxShell: page header", () => {
  it("renders the page header on the desktop three-pane layout", () => {
    mockBreakpoint.mockReturnValue("desktop")
    render(<InboxShell view="all" />)
    expect(screen.getByTestId("inbox-header")).toBeInTheDocument()
    expect(screen.getByTestId("inbox-open-connector-settings")).toBeInTheDocument()
  })

  // A phone gets one pane, and `MobileInboxBody` already carries a segmented
  // switcher above it. A second band would cost two rows of chrome for a title.
  it.each(["tablet", "mobile"])("does not render it on %s", (breakpoint) => {
    mockBreakpoint.mockReturnValue(breakpoint)
    render(<InboxShell view="all" />)
    expect(screen.queryByTestId("inbox-header")).not.toBeInTheDocument()
  })
})
