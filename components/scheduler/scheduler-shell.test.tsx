/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

// jsdom does not implement `window.matchMedia`; motion hooks read it.
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

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// Drive the breakpoint per test.
const mockBreakpoint = jest.fn().mockReturnValue("desktop")
jest.mock("@/hooks/ui", () => ({
  useBreakpoint: () => mockBreakpoint(),
  useIsMobile: () => mockBreakpoint() === "mobile",
}))

// Capture useResizableLayout wiring (storage key + persisted seed).
const mockOnLayoutChanged = jest.fn()
const mockUseResizableLayout = jest.fn().mockReturnValue({
  defaultLayout: undefined,
  onLayoutChanged: mockOnLayoutChanged,
})
jest.mock("@/hooks/ui/use-resizable-layout", () => ({
  useResizableLayout: (key: string) => mockUseResizableLayout(key),
}))

// Stub react-resizable-panels wrapper — the real Group measures the DOM which
// jsdom can't satisfy. Render panels as plain divs, forwarding test hooks.
jest.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({
    children,
    defaultLayout,
  }: {
    children: React.ReactNode
    defaultLayout?: Record<string, number>
  }) => (
    <div data-testid="resizable-group" data-default-layout={JSON.stringify(defaultLayout ?? null)}>
      {children}
    </div>
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
  SidebarInset: ({ children, ...rest }: { children?: React.ReactNode; [k: string]: unknown }) => (
    <main data-testid="scheduler-inset" {...rest}>
      {children}
    </main>
  ),
}))

// ---------------------------------------------------------------------------
// Subject
// ---------------------------------------------------------------------------

import { SchedulerShell, SCHEDULER_PANEL_STORAGE_KEY } from "./scheduler-shell"

function renderShell(overrides: Partial<React.ComponentProps<typeof SchedulerShell>> = {}) {
  return render(
    <SchedulerShell
      sidebar={(variant) => <div data-testid={`sidebar-${variant}`}>sidebar</div>}
      header={<div data-testid="shell-header">header</div>}
      detail={<div data-testid="shell-detail">detail</div>}
      rail={<div data-testid="shell-rail">rail</div>}
      mobileDetail={<div data-testid="shell-mobile-detail">mobile detail</div>}
      {...overrides}
    />
  )
}

describe("SchedulerShell", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockBreakpoint.mockReturnValue("desktop")
    mockUseResizableLayout.mockReturnValue({
      defaultLayout: undefined,
      onLayoutChanged: mockOnLayoutChanged,
    })
  })

  describe("desktop", () => {
    it("renders a resizable two-pane group with sidebar content (no chrome)", () => {
      renderShell()
      expect(screen.getByTestId("resizable-group")).toBeInTheDocument()
      expect(screen.getByTestId("scheduler-list-pane")).toBeInTheDocument()
      expect(screen.getByTestId("scheduler-detail-pane")).toBeInTheDocument()
      expect(screen.getByTestId("sidebar-content")).toBeInTheDocument()
      expect(screen.queryByTestId("sidebar-chrome")).not.toBeInTheDocument()
    })

    // react-resizable-panels v4 interprets bare numbers as PIXELS; sizes must
    // be percent strings or the panes collapse to px-wide slivers.
    it("passes percent-string sizes to every resizable panel", () => {
      renderShell()
      const percent = /^\d+(\.\d+)?%$/
      const list = screen.getByTestId("scheduler-list-pane")
      const detail = screen.getByTestId("scheduler-detail-pane")
      expect(list.dataset.defaultSize).toMatch(percent)
      expect(list.dataset.minSize).toMatch(percent)
      expect(list.dataset.maxSize).toMatch(percent)
      expect(detail.dataset.defaultSize).toMatch(percent)
      expect(detail.dataset.minSize).toMatch(percent)
    })

    it("persists the split through useResizableLayout('scheduler-panels')", () => {
      renderShell()
      expect(mockUseResizableLayout).toHaveBeenCalledWith(SCHEDULER_PANEL_STORAGE_KEY)
    })

    it("seeds the group with the persisted layout", () => {
      mockUseResizableLayout.mockReturnValue({
        defaultLayout: { "scheduler-list": 30, "scheduler-detail": 70 },
        onLayoutChanged: mockOnLayoutChanged,
      })
      renderShell()
      expect(screen.getByTestId("resizable-group").dataset.defaultLayout).toBe(
        JSON.stringify({ "scheduler-list": 30, "scheduler-detail": 70 })
      )
    })

    it("renders the rail and never the mobile overlay", () => {
      renderShell({ isMobileDetailOpen: true })
      expect(screen.getByTestId("shell-rail")).toBeInTheDocument()
      expect(screen.queryByTestId("scheduler-mobile-detail-shell")).not.toBeInTheDocument()
    })
  })

  describe("tablet", () => {
    beforeEach(() => mockBreakpoint.mockReturnValue("tablet"))

    it("uses the sidebar chrome in a flex layout without a panel group", () => {
      renderShell()
      expect(screen.queryByTestId("resizable-group")).not.toBeInTheDocument()
      expect(screen.getByTestId("sidebar-chrome")).toBeInTheDocument()
      expect(screen.getByTestId("scheduler-inset")).toBeInTheDocument()
    })

    it("does not render the rail (fixes the tablet crowding issue)", () => {
      renderShell()
      expect(screen.queryByTestId("shell-rail")).not.toBeInTheDocument()
    })

    it("never shows the mobile overlay even when flagged open", () => {
      renderShell({ isMobileDetailOpen: true })
      expect(screen.queryByTestId("scheduler-mobile-detail-shell")).not.toBeInTheDocument()
    })
  })

  describe("mobile", () => {
    beforeEach(() => mockBreakpoint.mockReturnValue("mobile"))

    it("shows the list when the detail overlay is closed", () => {
      renderShell({ isMobileDetailOpen: false })
      expect(screen.getByTestId("sidebar-chrome")).toBeInTheDocument()
      expect(screen.queryByTestId("scheduler-mobile-detail-shell")).not.toBeInTheDocument()
      expect(screen.queryByTestId("shell-rail")).not.toBeInTheDocument()
    })

    it("pushes the full-screen detail overlay and hides the list when open", () => {
      renderShell({ isMobileDetailOpen: true })
      expect(screen.getByTestId("scheduler-mobile-detail-shell")).toBeInTheDocument()
      expect(screen.getByTestId("shell-mobile-detail")).toBeInTheDocument()
      const listWrap = screen.getByTestId("sidebar-chrome").parentElement
      expect(listWrap?.className).toContain("hidden")
    })

    it("survives a breakpoint switch mid-selection", () => {
      const view = renderShell({ isMobileDetailOpen: true })
      expect(screen.getByTestId("scheduler-mobile-detail-shell")).toBeInTheDocument()

      mockBreakpoint.mockReturnValue("desktop")
      view.rerender(
        <SchedulerShell
          sidebar={(variant) => <div data-testid={`sidebar-${variant}`}>sidebar</div>}
          header={<div data-testid="shell-header">header</div>}
          detail={<div data-testid="shell-detail">detail</div>}
          rail={<div data-testid="shell-rail">rail</div>}
          mobileDetail={<div data-testid="shell-mobile-detail">mobile detail</div>}
          isMobileDetailOpen
        />
      )

      expect(screen.queryByTestId("scheduler-mobile-detail-shell")).not.toBeInTheDocument()
      expect(screen.getByTestId("scheduler-list-pane")).toBeInTheDocument()
    })
  })
})
