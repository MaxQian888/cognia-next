/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

// jsdom does not implement `window.matchMedia`. The shell subscribes to a
// `(min-width: 768px) and (max-width: 1023px)` media query in an effect, so
// every test mount needs the API present.
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

// Mock the project-level mobile-viewport hook so each test can drive the
// single-pane stacking rule deterministically without touching matchMedia.
const mockUseIsMobile = jest.fn().mockReturnValue(false)
jest.mock("@/hooks/ui", () => ({
  useIsMobile: () => mockUseIsMobile(),
}))

// Sidebar primitives — the full Radix implementation needs a host environment
// that is difficult to reproduce in jsdom; stub them to render children directly.
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
    mockUseIsMobile.mockReturnValue(false)
  })

  it("renders the sidebar, conversation-list pane, and detail pane", () => {
    render(<InboxShell view="all" />)

    expect(screen.getByTestId("sidebar")).toBeInTheDocument()
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

  it("middle pane uses responsive Tailwind widths (mobile → tablet → desktop)", () => {
    render(<InboxShell view="all" />)
    const middle = screen.getByTestId("inbox-conversation-list-pane")
    // < 768 px: full-width single-pane (`w-full`); md+ uses w-64, lg+ w-72.
    expect(middle.className).toContain("w-full")
    expect(middle.className).toContain("md:w-64")
    expect(middle.className).toContain("lg:w-72")
  })

  it("middle pane uses the RTL-safe logical border (border-e, not border-r)", () => {
    render(<InboxShell view="all" />)
    const middle = screen.getByTestId("inbox-conversation-list-pane")
    expect(middle.className).toContain("border-e")
    expect(middle.className).not.toMatch(/(^|\s)border-r(\s|$)/)
  })

  it("desktop viewport renders both panes regardless of conversationKey", () => {
    mockUseIsMobile.mockReturnValue(false)
    render(<InboxShell view="conversation" conversationKey="ck1" />)

    const middle = screen.getByTestId("inbox-conversation-list-pane")
    const detail = screen.getByTestId("inbox-detail-pane")
    expect(middle.className).not.toMatch(/(^|\s)hidden(\s|$)/)
    expect(detail.className).not.toMatch(/(^|\s)hidden(\s|$)/)
  })

  it("mobile viewport with no conversation key shows the list only", () => {
    mockUseIsMobile.mockReturnValue(true)
    render(<InboxShell view="all" />)

    const middle = screen.getByTestId("inbox-conversation-list-pane")
    const detail = screen.getByTestId("inbox-detail-pane")
    // List visible by default on mobile, detail hidden until md+.
    expect(middle.className).not.toMatch(/(^|\s)hidden(\s|$)/)
    expect(detail.className).toContain("hidden")
    expect(detail.className).toContain("md:flex")
  })

  it("mobile viewport with a conversation key shows the detail only", () => {
    mockUseIsMobile.mockReturnValue(true)
    render(<InboxShell view="conversation" conversationKey="ck-mobile" />)

    const middle = screen.getByTestId("inbox-conversation-list-pane")
    const detail = screen.getByTestId("inbox-detail-pane")
    expect(middle.className).toContain("hidden")
    expect(middle.className).toContain("md:flex")
    expect(detail.className).not.toMatch(/(^|\s)hidden(\s|$)/)
  })

  it("subscribes to matchMedia at mount and detects tablet viewport", () => {
    const listeners: Array<(e: MediaQueryListEvent) => void> = []
    const matchSpy = jest.spyOn(window, "matchMedia").mockImplementation((query) => {
      const mql: MediaQueryList = {
        matches: true, // pretend we're in the tablet band
        media: query,
        onchange: null,
        addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
          listeners.push(listener as (e: MediaQueryListEvent) => void)
        },
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      } as unknown as MediaQueryList
      return mql
    })

    render(<InboxShell view="all" />)

    expect(matchSpy).toHaveBeenCalledWith("(min-width: 768px) and (max-width: 1023px)")
    matchSpy.mockRestore()
  })
})
