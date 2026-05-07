/**
 * Tests for CanvasShell — desktop resizable layout + mobile Sheet fallback.
 */

import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import "@testing-library/jest-dom"
import { CanvasShell } from "./canvas-shell"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useCanvasLayoutStore } from "@/stores/canvas/canvas-layout-store"

// Stub the heavy children — we are testing the shell's layout, not the rails.
jest.mock("./canvas-document-rail", () => ({
  CanvasDocumentRail: () => <div data-testid="document-rail">Document rail</div>,
}))
jest.mock("./canvas-side-panels", () => ({
  CanvasSidePanels: () => <div data-testid="side-panels">Side panels</div>,
}))
jest.mock("./canvas-workspace", () => ({
  CanvasWorkspace: () => <div data-testid="workspace">Workspace</div>,
}))

// Avoid registering the real keyboard listener in every test render.
jest.mock("@/hooks/canvas/use-canvas-layout-shortcuts", () => ({
  useCanvasLayoutShortcuts: jest.fn(),
}))

// react-resizable-panels relies on a layout measurement loop that doesn't
// work in jsdom — replace its primitives with simple divs that pass
// children through. The shadcn wrapper imports `Group`, `Panel`, and
// `Separator` from this module (see components/ui/resizable.tsx).
jest.mock("react-resizable-panels", () => {
  const ReactImpl = jest.requireActual<typeof import("react")>("react")
  type DivProps = React.ComponentProps<"div"> & { children?: React.ReactNode }
  const filterProps = ({
    orientation: _orientation,
    onLayoutChanged: _onLayoutChanged,
    onLayoutChange: _onLayoutChange,
    defaultSize: _defaultSize,
    minSize: _minSize,
    maxSize: _maxSize,
    collapsible: _collapsible,
    collapsedSize: _collapsedSize,
    withHandle: _withHandle,
    ...rest
  }: DivProps & Record<string, unknown>) => rest
  return {
    Group: ({ children, ...rest }: DivProps) =>
      ReactImpl.createElement(
        "div",
        { "data-testid": "panel-group", ...filterProps(rest) },
        children
      ),
    Panel: ({ children, ...rest }: DivProps) =>
      ReactImpl.createElement("div", { "data-testid": "panel", ...filterProps(rest) }, children),
    Separator: ({ children, ...rest }: DivProps) =>
      ReactImpl.createElement(
        "div",
        { "data-testid": "panel-resize-handle", ...filterProps(rest) },
        children
      ),
  }
})

jest.mock("@/hooks/ui", () => ({
  useIsMobile: jest.fn(() => false),
}))

import { useIsMobile } from "@/hooks/ui"

const useIsMobileMock = useIsMobile as jest.MockedFunction<typeof useIsMobile>

function renderWithProviders(ui: React.ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>)
}

describe("CanvasShell", () => {
  beforeEach(() => {
    window.localStorage.clear()
    useIsMobileMock.mockReturnValue(false)
    act(() => {
      useCanvasLayoutStore.getState().resetLayout()
    })
  })

  describe("desktop branch", () => {
    it("renders document rail, workspace, and side panels by default", () => {
      renderWithProviders(<CanvasShell />)
      expect(screen.getByTestId("document-rail")).toBeInTheDocument()
      expect(screen.getByTestId("workspace")).toBeInTheDocument()
      expect(screen.getByTestId("side-panels")).toBeInTheDocument()
    })

    it("renders 3 panels and 2 handles when both rails open", () => {
      renderWithProviders(<CanvasShell />)
      expect(screen.getAllByTestId("panel")).toHaveLength(3)
      expect(screen.getAllByTestId("panel-resize-handle")).toHaveLength(2)
    })

    it("wraps the center pane with min-w-0 to allow flex shrinking", () => {
      const { container } = renderWithProviders(<CanvasShell />)
      const minWrapped = container.querySelector(".min-w-0")
      expect(minWrapped).not.toBeNull()
    })

    it("keeps all panels in DOM when leftCollapsed=true (opacity-0, collapsible handles collapse)", () => {
      act(() => {
        useCanvasLayoutStore.getState().setLeftCollapsed(true)
      })
      renderWithProviders(<CanvasShell />)
      // Panels are always mounted — the library handles collapse via size=0.
      expect(screen.getByTestId("document-rail")).toBeInTheDocument()
      expect(screen.getAllByTestId("panel")).toHaveLength(3)
      expect(screen.getAllByTestId("panel-resize-handle")).toHaveLength(2)
      // No floating expand button — react-resizable-panels collapsible handles expand.
      expect(screen.queryByRole("button", { name: /Show document rail/i })).not.toBeInTheDocument()
    })

    it("keeps all panels in DOM when rightCollapsed=true (opacity-0, collapsible handles collapse)", () => {
      act(() => {
        useCanvasLayoutStore.getState().setRightCollapsed(true)
      })
      renderWithProviders(<CanvasShell />)
      expect(screen.getByTestId("side-panels")).toBeInTheDocument()
      expect(screen.getAllByTestId("panel")).toHaveLength(3)
      expect(screen.getAllByTestId("panel-resize-handle")).toHaveLength(2)
      expect(screen.queryByRole("button", { name: /Show tools rail/i })).not.toBeInTheDocument()
    })
  })

  describe("mobile branch", () => {
    beforeEach(() => {
      useIsMobileMock.mockReturnValue(true)
    })

    it("renders the workspace plus two Sheet trigger buttons", () => {
      renderWithProviders(<CanvasShell />)
      expect(screen.getByTestId("workspace")).toBeInTheDocument()
      expect(screen.getByRole("button", { name: /Open documents/i })).toBeInTheDocument()
      expect(screen.getByRole("button", { name: /Open tools/i })).toBeInTheDocument()
    })

    it("does not render the resizable panel-group on mobile", () => {
      renderWithProviders(<CanvasShell />)
      expect(screen.queryByTestId("panel-group")).not.toBeInTheDocument()
    })

    it("clicking the documents button opens the left Sheet", async () => {
      renderWithProviders(<CanvasShell />)
      expect(useCanvasLayoutStore.getState().mobileLeftOpen).toBe(false)
      await userEvent.setup().click(screen.getByRole("button", { name: /Open documents/i }))
      expect(useCanvasLayoutStore.getState().mobileLeftOpen).toBe(true)
    })

    it("clicking the tools button opens the right Sheet", async () => {
      renderWithProviders(<CanvasShell />)
      await userEvent.setup().click(screen.getByRole("button", { name: /Open tools/i }))
      expect(useCanvasLayoutStore.getState().mobileRightOpen).toBe(true)
    })
  })
})
