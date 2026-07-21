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

jest.mock("@/components/ui/resizable", () => {
  const { useImperativeHandle, useRef, useState } =
    jest.requireActual<typeof import("react")>("react")

  type MockPanelHandle = {
    collapse: () => void
    expand: () => void
    getSize: () => { asPercentage: number; inPixels: number }
    isCollapsed: () => boolean
    resize: (size: number | string) => void
  }

  return {
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
    ResizablePanel: ({
      children,
      id,
      defaultSize,
      minSize,
      maxSize,
      elementRef,
      panelRef,
    }: {
      children: React.ReactNode
      id: string
      defaultSize?: number | string
      minSize?: number | string
      maxSize?: number | string
      elementRef?: React.Ref<HTMLDivElement>
      panelRef?: React.Ref<MockPanelHandle>
    }) => {
      const [size, setSize] = useState(defaultSize)
      const collapsedRef = useRef(defaultSize === "0%")
      useImperativeHandle(panelRef, () => ({
        collapse: () => {
          collapsedRef.current = true
          setSize("0%")
        },
        expand: () => {
          collapsedRef.current = false
          setSize(defaultSize)
        },
        getSize: () => ({ asPercentage: 0, inPixels: 0 }),
        isCollapsed: () => collapsedRef.current,
        resize: (nextSize) => {
          collapsedRef.current = nextSize === 0 || nextSize === "0%"
          setSize(nextSize)
        },
      }))
      return (
        <div
          ref={elementRef}
          data-testid={`resizable-panel-${id}`}
          data-size={size}
          data-min={minSize}
          data-max={maxSize}
        >
          {children}
        </div>
      )
    },
    ResizableHandle: () => <div />,
  }
})

jest.mock("./artifact-dock", () => ({
  ArtifactDock: () => <div data-testid="dock" />,
}))

jest.mock("./artifact-panel", () => ({
  ArtifactPanel: () => <div data-testid="sheet-panel" />,
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
    // ONE Sheet now, not two: the standalone Workspace Sheet is gone and the
    // workspace is a panel inside the workbench Sheet like everything else.
    expect(screen.getAllByTestId("sheet-panel")).toHaveLength(1)
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
  })

  it("raises the single Sheet when a Workspace reveal arrives on mobile", async () => {
    useBreakpointMock.mockReturnValue("mobile")
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

    // The reveal used to have to close the Artifact Sheet to make room for the
    // Workspace one; now it just opens the one Sheet on the workspace panel.
    await waitFor(() => expect(useArtifactStore.getState().panelOpen).toBe(true))
    expect(useArtifactDockLayoutStore.getState().dockProfile).toBe("workspace")
  })

  it("keeps the sheet-open request in step when the panel closes on mobile", async () => {
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

    // The reveal raised the Sheet; closing the panel must retract the request
    // too, or a stale `mobileSheetOpen` re-opens it on the next render.
    await waitFor(() => expect(useArtifactStore.getState().panelOpen).toBe(true))
    act(() => useArtifactStore.getState().closePanel())

    await waitFor(() => expect(useArtifactDockLayoutStore.getState().mobileSheetOpen).toBe(false))
    expect(useArtifactStore.getState().panelOpen).toBe(false)
  })

  it("auto-expands the dock when a new artifact becomes active", () => {
    expect(useArtifactDockLayoutStore.getState().dockCollapsed).toBe(true)
    act(() => useArtifactDockLayoutStore.getState().setDockProfile("workspace"))
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

  it("animates collapse/expand via a motion-speed-scaled inline transition", async () => {
    render(
      <ArtifactWorkspaceDock>
        <div data-testid="chat" />
      </ArtifactWorkspaceDock>
    )

    expect(screen.getByTestId("resizable-panel-artifact-dock")).toHaveAttribute("data-size", "0%")

    act(() => useArtifactDockLayoutStore.getState().setDockCollapsed(false))
    const dockPanel = screen.getByTestId("resizable-panel-artifact-dock")
    expect(dockPanel).toHaveAttribute("data-size", "34%")
    // Inline styles (not Tailwind classes) so the duration can consume the
    // user's --motion-duration-scale preference.
    expect(dockPanel.style.transitionProperty).toBe("flex-grow")
    expect(dockPanel.style.transitionTimingFunction).toBe("ease-in-out")
    expect(dockPanel.getAttribute("style") ?? "").toContain("--motion-duration-scale")

    // Transition is removed after the (scaled) animation so manual dragging stays immediate.
    await waitFor(() => expect(dockPanel.style.transitionProperty).toBe(""))

    act(() => useArtifactDockLayoutStore.getState().setDockCollapsed(true))
    expect(dockPanel).toHaveAttribute("data-size", "0%")
    expect(dockPanel.style.transitionProperty).toBe("flex-grow")
  })

  it("widens the dock bounds and reclaims chat width in workspace mode", () => {
    render(
      <ArtifactWorkspaceDock>
        <div data-testid="chat" />
      </ArtifactWorkspaceDock>
    )

    // Artifact mode (default): 24–50% dock, 50% chat floor.
    expect(screen.getByTestId("resizable-panel-artifact-dock")).toHaveAttribute("data-min", "24%")
    expect(screen.getByTestId("resizable-panel-artifact-dock")).toHaveAttribute("data-max", "50%")
    expect(screen.getByTestId("resizable-panel-artifact-chat")).toHaveAttribute("data-min", "50%")

    // Workspace mode: absolute pixel floor, wider cap, chat floor drops to 35%.
    act(() => useArtifactDockLayoutStore.getState().setDockProfile("workspace"))
    expect(screen.getByTestId("resizable-panel-artifact-dock")).toHaveAttribute("data-min", "480px")
    expect(screen.getByTestId("resizable-panel-artifact-dock")).toHaveAttribute("data-max", "65%")
    expect(screen.getByTestId("resizable-panel-artifact-chat")).toHaveAttribute("data-min", "35%")
  })

  it("applies a width preset to the docked panel straight away", async () => {
    render(
      <ArtifactWorkspaceDock>
        <div data-testid="chat" />
      </ArtifactWorkspaceDock>
    )
    act(() => useArtifactDockLayoutStore.getState().setDockCollapsed(false))
    const dockPanel = screen.getByTestId("resizable-panel-artifact-dock")
    expect(dockPanel).toHaveAttribute("data-size", "34%")

    act(() => useArtifactDockLayoutStore.getState().requestDockSize(50))

    await waitFor(() => expect(dockPanel).toHaveAttribute("data-size", "50%"))
  })

  it("ignores per-tick drag writes so a preset never fights the pointer", () => {
    render(
      <ArtifactWorkspaceDock>
        <div data-testid="chat" />
      </ArtifactWorkspaceDock>
    )
    act(() => useArtifactDockLayoutStore.getState().setDockCollapsed(false))
    const dockPanel = screen.getByTestId("resizable-panel-artifact-dock")

    // `setDockSize` is what a drag calls on every tick — it must not re-drive
    // the panel, or the dock would fight the pointer mid-drag.
    act(() => useArtifactDockLayoutStore.getState().setDockSize(45))

    expect(useArtifactDockLayoutStore.getState().dockSize).toBe(45)
    expect(dockPanel).toHaveAttribute("data-size", "34%")
  })

  it("does not force-expand a dismissed dock — only flags it unread", () => {
    render(
      <ArtifactWorkspaceDock>
        <div data-testid="chat" />
      </ArtifactWorkspaceDock>
    )
    // User manually dismisses the dock.
    act(() => useArtifactDockLayoutStore.getState().setDockCollapsed(true))
    expect(useArtifactDockLayoutStore.getState().userDismissed).toBe(true)

    // A fresh artifact must not yank it open again.
    act(() => useArtifactStore.setState({ activeArtifactId: "a-new" }))
    expect(useArtifactDockLayoutStore.getState().dockCollapsed).toBe(true)
    expect(useArtifactDockLayoutStore.getState().unreadArtifact).toBe(true)
  })
})
