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

// Drive the breakpoint per test. `useIsMobile` is retained for any child that
// still consumes it.
const mockBreakpoint = jest.fn().mockReturnValue("desktop")
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
    ...rest
  }: {
    children: React.ReactNode
    className?: string
    [k: string]: unknown
  }) => (
    <div className={className} data-testid={rest["data-testid"] as string}>
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
  })

  describe("desktop", () => {
    it("renders a resizable three-pane group", () => {
      render(<InboxShell view="all" />)
      expect(screen.getByTestId("resizable-group")).toBeInTheDocument()
      expect(screen.getByTestId("inbox-sidebar-pane")).toBeInTheDocument()
      expect(screen.getByTestId("inbox-conversation-list-pane")).toBeInTheDocument()
      expect(screen.getByTestId("inbox-detail-pane")).toBeInTheDocument()
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
