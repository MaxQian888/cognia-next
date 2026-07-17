/**
 * @jest-environment jsdom
 */

import { render, screen, act, waitFor } from "@testing-library/react"

jest.mock("@/hooks/ui", () => ({
  useBreakpoint: jest.fn(() => "desktop"),
}))

jest.mock("@/hooks/artifacts/use-artifact-dock-shortcuts", () => ({
  useArtifactDockShortcuts: jest.fn(),
}))

jest.mock("@/lib/ui/motion", () => ({
  mobileTransition: () => ({}),
  useReducedMotionTransition: (t: unknown) => t,
}))

jest.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({
    children,
    onLayoutChanged,
  }: {
    children: React.ReactNode
    onLayoutChanged?: (layout: Record<string, number>) => void
  }) => (
    <div>
      {children}
      <button
        type="button"
        data-testid="resize-dock"
        onClick={() => onLayoutChanged?.({ "artifact-dock": 42 })}
      />
    </div>
  ),
  ResizablePanel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResizableHandle: () => <div />,
}))

// motion/react → plain divs so layout/animate props don't choke jsdom.
jest.mock("motion/react", () => ({
  motion: new Proxy(
    {},
    {
      get:
        () =>
        ({ children, ...props }: { children?: React.ReactNode }) => {
          // strip framer-only props
          const {
            layout: _l,
            animate: _a,
            transition: _t,
            ...rest
          } = props as Record<string, unknown>
          return <div {...rest}>{children}</div>
        },
    }
  ),
}))

jest.mock("./artifact-dock", () => ({
  ArtifactDock: () => <div data-testid="dock" />,
}))

jest.mock("./artifact-panel", () => ({
  ArtifactPanel: () => <div data-testid="sheet-panel" />,
}))
jest.mock("./workspace-mode/mobile-workspace-sheet", () => ({
  MobileWorkspaceSheet: () => <div data-testid="workspace-sheet" />,
}))
jest.mock("./workspace-mode/workspace-reveal-opener", () => ({
  WorkspaceRevealOpener: () => <div data-testid="workspace-reveal-opener" />,
}))

import { ArtifactWorkspaceDock } from "./artifact-workspace-dock"
import { useBreakpoint } from "@/hooks/ui"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"

const useBreakpointMock = useBreakpoint as jest.MockedFunction<typeof useBreakpoint>

beforeEach(() => {
  localStorage.clear()
  useBreakpointMock.mockReturnValue("desktop")
  act(() => {
    useArtifactDockLayoutStore.getState().resetLayout()
    useArtifactStore.setState({ activeArtifactId: null, panelOpen: false, panelView: "artifact" })
  })
})

describe("ArtifactWorkspaceDock", () => {
  it("desktop: renders children plus the dock (no Sheet)", () => {
    render(
      <ArtifactWorkspaceDock>
        <div data-testid="chat" />
      </ArtifactWorkspaceDock>
    )
    expect(screen.getByTestId("chat")).toBeInTheDocument()
    expect(screen.getByTestId("dock")).toBeInTheDocument()
    expect(screen.queryByTestId("sheet-panel")).not.toBeInTheDocument()
  })

  it("mobile: renders children plus the Sheet fallback (no resizable dock)", () => {
    useBreakpointMock.mockReturnValue("mobile")
    render(
      <ArtifactWorkspaceDock>
        <div data-testid="chat" />
      </ArtifactWorkspaceDock>
    )
    expect(screen.getByTestId("chat")).toBeInTheDocument()
    expect(screen.getByTestId("sheet-panel")).toBeInTheDocument()
    expect(screen.getByTestId("workspace-sheet")).toBeInTheDocument()
    expect(screen.getByTestId("workspace-reveal-opener")).toBeInTheDocument()
    expect(screen.queryByTestId("artifact-workspace-dock")).not.toBeInTheDocument()
  })

  it("tablet: also uses the Sheet fallback", () => {
    useBreakpointMock.mockReturnValue("tablet")
    render(
      <ArtifactWorkspaceDock>
        <div data-testid="chat" />
      </ArtifactWorkspaceDock>
    )
    expect(screen.getByTestId("sheet-panel")).toBeInTheDocument()
    expect(screen.getByTestId("workspace-sheet")).toBeInTheDocument()
  })

  it("closes the Artifact Sheet when a Workspace reveal opens on mobile", async () => {
    useBreakpointMock.mockReturnValue("mobile")
    act(() => useArtifactStore.getState().openPanel("artifact"))
    render(
      <ArtifactWorkspaceDock>
        <div data-testid="chat" />
      </ArtifactWorkspaceDock>
    )

    act(() => {
      useArtifactDockLayoutStore.getState().revealWorkspaceReview({
        sessionId: "session-1",
        rootPath: "/repo",
      })
    })

    await waitFor(() => expect(useArtifactStore.getState().panelOpen).toBe(false))
    expect(useArtifactDockLayoutStore.getState().dockMode).toBe("workspace")
  })

  it("switches back to Artifact mode when a new artifact arrives on mobile", async () => {
    useBreakpointMock.mockReturnValue("mobile")
    act(() => {
      useArtifactDockLayoutStore.getState().revealWorkspaceReview({
        sessionId: "session-1",
        rootPath: "/repo",
      })
    })
    render(
      <ArtifactWorkspaceDock>
        <div data-testid="chat" />
      </ArtifactWorkspaceDock>
    )

    act(() => useArtifactStore.setState({ activeArtifactId: "artifact-mobile" }))

    await waitFor(() => expect(useArtifactDockLayoutStore.getState().dockMode).toBe("artifact"))
    expect(useArtifactDockLayoutStore.getState().mobileSheetOpen).toBe(false)
  })

  it("auto-expands the dock when a new artifact becomes active", () => {
    expect(useArtifactDockLayoutStore.getState().dockCollapsed).toBe(true)
    act(() => useArtifactDockLayoutStore.getState().setDockMode("workspace"))
    const { rerender } = render(
      <ArtifactWorkspaceDock>
        <div data-testid="chat" />
      </ArtifactWorkspaceDock>
    )
    act(() => useArtifactStore.setState({ activeArtifactId: "a-1" }))
    rerender(
      <ArtifactWorkspaceDock>
        <div data-testid="chat" />
      </ArtifactWorkspaceDock>
    )
    expect(useArtifactDockLayoutStore.getState().dockCollapsed).toBe(false)
    expect(useArtifactDockLayoutStore.getState().dockMode).toBe("artifact")
  })

  it("persists desktop dock resizing through the shared layout store", () => {
    act(() => useArtifactDockLayoutStore.getState().setDockCollapsed(false))
    render(
      <ArtifactWorkspaceDock>
        <div data-testid="chat" />
      </ArtifactWorkspaceDock>
    )

    act(() => screen.getByTestId("resize-dock").click())
    expect(useArtifactDockLayoutStore.getState().dockSize).toBe(42)
  })
})
