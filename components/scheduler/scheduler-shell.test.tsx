/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"

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

const mockCollapse = jest.fn()
const mockResize = jest.fn()

// Stub react-resizable-panels wrapper — the real Group measures the DOM which
// jsdom can't satisfy. Render panels as plain divs, forwarding test hooks.
jest.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({
    children,
    defaultLayout,
    onLayoutChanged,
    className,
  }: {
    children: React.ReactNode
    className?: string
    defaultLayout?: Record<string, number>
    onLayoutChanged?: (next: Record<string, number>) => void
  }) => (
    <div
      className={className}
      data-testid="resizable-group"
      data-default-layout={JSON.stringify(defaultLayout ?? null)}
    >
      <button
        type="button"
        data-testid="mock-layout-change"
        onClick={() => onLayoutChanged?.({ "scheduler-list": 30, "scheduler-detail": 70 })}
      />
      <button
        type="button"
        data-testid="mock-drag-collapse"
        onClick={() => onLayoutChanged?.({ "scheduler-list": 0, "scheduler-detail": 100 })}
      />
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
  }) => {
    const panelRef = rest.panelRef as { current: unknown } | undefined
    if (panelRef) panelRef.current = { collapse: mockCollapse, resize: mockResize }
    return (
      <div
        className={className}
        data-testid={rest["data-testid"] as string}
        data-collapsed={rest["data-collapsed"] as string | undefined}
        data-default-size={defaultSize === undefined ? undefined : String(defaultSize)}
        data-min-size={minSize === undefined ? undefined : String(minSize)}
        data-max-size={maxSize === undefined ? undefined : String(maxSize)}
      >
        {children}
      </div>
    )
  },
  ResizableHandle: ({
    className,
    onPointerDownCapture,
    onKeyDownCapture,
  }: React.HTMLAttributes<HTMLDivElement>) => (
    <div
      data-testid="resizable-handle"
      className={className}
      onPointerDownCapture={onPointerDownCapture}
      onKeyDownCapture={onKeyDownCapture}
    />
  ),
}))

// Sidebar primitives — stub to render children directly. The provider mock
// exposes its controlled open/onOpenChange wiring so tests can drive the
// collapse toggle exactly like the header's SidebarTrigger would.
jest.mock("@/components/ui/sidebar", () => ({
  SidebarProvider: ({
    children,
    open,
    onOpenChange,
  }: {
    children: React.ReactNode
    open?: boolean
    onOpenChange?: (open: boolean) => void
  }) => (
    <div data-testid="sidebar-provider" data-open={open === undefined ? undefined : String(open)}>
      <button
        type="button"
        data-testid="mock-sidebar-toggle"
        onClick={() => onOpenChange?.(!(open ?? true))}
      />
      {children}
    </div>
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

import {
  SchedulerShell,
  SCHEDULER_PANEL_STORAGE_KEY,
  SCHEDULER_LIST_COLLAPSED_KEY,
} from "./scheduler-shell"

function renderShell(overrides: Partial<React.ComponentProps<typeof SchedulerShell>> = {}) {
  return render(
    <SchedulerShell
      sidebar={(variant) => <div data-testid={`sidebar-${variant}`}>sidebar</div>}
      header={<div data-testid="shell-header">header</div>}
      detail={<div data-testid="shell-detail">detail</div>}
      rail={<div data-testid="shell-rail">rail</div>}
      {...overrides}
    />
  )
}

describe("SchedulerShell", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    window.localStorage.removeItem(SCHEDULER_LIST_COLLAPSED_KEY)
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
    // carry an explicit unit or the panes collapse to px-wide slivers.
    it("passes unit-bearing sizes to every resizable panel", () => {
      renderShell()
      const percent = /^\d+(\.\d+)?%$/
      const list = screen.getByTestId("scheduler-list-pane")
      const detail = screen.getByTestId("scheduler-detail-pane")
      expect(list.dataset.defaultSize).toBe("15rem")
      // The floor follows the settings sidebar, never a percentage of the window.
      expect(list.dataset.minSize).toBe("15rem")
      expect(list.dataset.maxSize).toMatch(percent)
      expect(detail.dataset.defaultSize).toMatch(percent)
      expect(detail.dataset.minSize).toMatch(percent)
    })

    it("keeps list and detail DOM mounted through collapse and expand", () => {
      renderShell({ detail: <input aria-label="Draft" defaultValue="keep me" /> })
      const list = screen.getByTestId("sidebar-content")
      const draft = screen.getByRole("textbox", { name: "Draft" })
      fireEvent.change(draft, { target: { value: "unfinished edit" } })
      fireEvent.click(screen.getByTestId("mock-sidebar-toggle"))
      expect(screen.getByTestId("sidebar-content")).toBe(list)
      expect(screen.getByRole("textbox", { name: "Draft" })).toBe(draft)
      fireEvent.click(screen.getByTestId("mock-sidebar-toggle"))
      expect(draft).toHaveValue("unfinished edit")
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

    // Over a wallpaper the list pane turns to glass: its tint comes from
    // `--sidebar-pane-bg` (falling back to the solid sidebar colour) and its
    // blur from `--sidebar-pane-filter` (see globals.css). A literal
    // `bg-sidebar` would paint an opaque slab over the wallpaper.
    it("tints the list pane through the glass-aware sidebar variables", () => {
      renderShell()
      const classes = screen.getByTestId("scheduler-list-pane").className.split(/\s+/)
      expect(classes).toContain("bg-[var(--sidebar-pane-bg,var(--sidebar))]")
      expect(classes).toContain("[backdrop-filter:var(--sidebar-pane-filter,none)]")
      expect(classes).not.toContain("bg-sidebar")
      expect(classes).toContain("text-sidebar-foreground")
    })

    it("renders the rail", () => {
      renderShell()
      expect(screen.getByTestId("shell-rail")).toBeInTheDocument()
    })

    describe("list-panel collapse", () => {
      beforeEach(() => window.localStorage.removeItem(SCHEDULER_LIST_COLLAPSED_KEY))

      it("starts expanded and wires the provider as controlled-open", () => {
        renderShell()
        expect(screen.getByTestId("sidebar-provider").dataset.open).toBe("true")
        expect(screen.getByTestId("scheduler-list-pane").dataset.collapsed).toBeUndefined()
      })

      it("collapses the list pane to 0% when the sidebar trigger toggles", () => {
        renderShell()
        fireEvent.click(screen.getByTestId("mock-sidebar-toggle"))

        const list = screen.getByTestId("scheduler-list-pane")
        expect(list.dataset.collapsed).toBe("true")
        expect(mockCollapse).toHaveBeenCalledTimes(1)
        expect(list.dataset.minSize).toBe("15rem")
        expect(screen.getByTestId("sidebar-content").parentElement).toHaveAttribute("inert")
        // Handle disappears so no phantom drag affordance remains.
        expect(screen.getByTestId("resizable-handle").className).toContain("hidden")
        // Collapsed flag persists for the next mount.
        expect(window.localStorage.getItem(SCHEDULER_LIST_COLLAPSED_KEY)).toBe("1")
      })

      it("expands back to the settings width on a second toggle", () => {
        renderShell()
        fireEvent.click(screen.getByTestId("mock-sidebar-toggle"))
        fireEvent.click(screen.getByTestId("mock-sidebar-toggle"))

        const list = screen.getByTestId("scheduler-list-pane")
        expect(list.dataset.collapsed).toBeUndefined()
        expect(mockResize).toHaveBeenLastCalledWith("15rem")
        expect(screen.getByTestId("sidebar-content").parentElement).not.toHaveAttribute("inert")
        expect(list.dataset.minSize).not.toBe("0%")
        expect(window.localStorage.getItem(SCHEDULER_LIST_COLLAPSED_KEY)).toBe("0")
      })

      it("animates toggles but stops animating before a resize gesture", () => {
        renderShell()
        fireEvent.click(screen.getByTestId("mock-sidebar-toggle"))
        expect(screen.getByTestId("resizable-group").className).toContain("transition-[flex-grow]")
        fireEvent.click(screen.getByTestId("mock-sidebar-toggle"))
        fireEvent.pointerDown(screen.getByTestId("resizable-handle"))
        expect(screen.getByTestId("resizable-group").className).not.toContain(
          "transition-[flex-grow]"
        )
      })

      it("tracks collapse from the resize handle without losing the saved split", () => {
        renderShell()
        fireEvent.click(screen.getByTestId("mock-layout-change"))
        fireEvent.click(screen.getByTestId("mock-drag-collapse"))
        expect(screen.getByTestId("sidebar-provider").dataset.open).toBe("false")
        expect(mockOnLayoutChanged).toHaveBeenCalledTimes(1)
        expect(window.localStorage.getItem(SCHEDULER_LIST_COLLAPSED_KEY)).toBe("1")
        fireEvent.click(screen.getByTestId("mock-sidebar-toggle"))
        expect(mockResize).toHaveBeenLastCalledWith("30%")
      })

      it("restores the collapsed state from localStorage on mount", () => {
        window.localStorage.setItem(SCHEDULER_LIST_COLLAPSED_KEY, "1")
        renderShell()
        expect(screen.getByTestId("sidebar-provider").dataset.open).toBe("false")
        expect(screen.getByTestId("scheduler-list-pane").dataset.collapsed).toBe("true")
      })

      it("does not persist the collapsed 0% split through useResizableLayout", () => {
        renderShell()
        // Expanded: layout changes flow through to the persistence hook.
        fireEvent.click(screen.getByTestId("mock-layout-change"))
        expect(mockOnLayoutChanged).toHaveBeenCalledTimes(1)

        fireEvent.click(screen.getByTestId("mock-sidebar-toggle"))
        // Layout writes are swallowed while collapsed.
        fireEvent.click(screen.getByTestId("mock-layout-change"))
        expect(mockOnLayoutChanged).toHaveBeenCalledTimes(1)
      })

      it("restores the last settled split without remounting the group", () => {
        renderShell()
        fireEvent.click(screen.getByTestId("mock-layout-change"))
        fireEvent.click(screen.getByTestId("mock-sidebar-toggle"))
        fireEvent.click(screen.getByTestId("mock-sidebar-toggle"))
        expect(mockResize).toHaveBeenLastCalledWith("30%")
      })
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
  })

  describe("mobile", () => {
    beforeEach(() => mockBreakpoint.mockReturnValue("mobile"))

    it("falls back to the tablet layout; the routes redirect a phone to /me/scheduler", () => {
      renderShell()
      expect(screen.getByTestId("sidebar-chrome")).toBeInTheDocument()
      expect(screen.queryByTestId("shell-rail")).not.toBeInTheDocument()
      expect(screen.queryByTestId("scheduler-mobile-detail-shell")).not.toBeInTheDocument()
    })
  })
})
