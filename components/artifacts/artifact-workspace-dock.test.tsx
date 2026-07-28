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
        <button
          type="button"
          data-testid="resize-dock-narrow"
          onClick={() => onLayoutChanged?.({ "artifact-dock": 19 })}
        />
        <button
          type="button"
          data-testid="resize-dock-collapsed"
          onClick={() => onLayoutChanged?.({ "artifact-dock": 0 })}
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
    ResizableHandle: ({
      className,
      onDoubleClick,
    }: {
      className?: string
      onDoubleClick?: () => void
    }) => (
      <div data-testid="resizable-handle" className={className} onDoubleClick={onDoubleClick} />
    ),
  }
})

// Renders the Pro IDE reserved-region marker the real dock tree carries when
// CodeServerPane is mounted. Harmless for every other test: the region only
// counts as "pinned" once a surface has actually claimed the native pane.
// Literal attribute name rather than the imported constant — a jest.mock
// factory referencing a module-scope import hits the TDZ trap.
jest.mock("./artifact-dock", () => ({
  ArtifactDock: () => <div data-testid="dock" data-pro-ide-region="" />,
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
import { useChatStore } from "@/stores/chat"

const SESSION = "session-1"
import {
  __resetCodeServerPaneManagerForTesting,
  claimCodeServerPane,
} from "@/lib/codeserver/pane-manager"

const useBreakpointMock = useBreakpoint as jest.MockedFunction<typeof useBreakpoint>

const RECT = { x: 0, y: 0, width: 400, height: 600 }

beforeEach(() => {
  localStorage.clear()
  useBreakpointMock.mockReturnValue("desktop")
  __resetCodeServerPaneManagerForTesting()
  act(() => {
    useArtifactDockLayoutStore.getState().resetLayout()
    // Tabs and the active artifact are bucketed per conversation.
    useChatStore.setState({ activeSessionId: SESSION })
    useArtifactStore.setState({
      activeArtifactIdBySession: {},
      openArtifactIdsBySession: {},
      panelOpen: false,
      panelView: "artifact",
    })
  })
})

describe("ArtifactWorkspaceDock", () => {
  it("desktop: renders children plus the dock (no Sheet)", () => {
    act(() => useArtifactDockLayoutStore.getState().setDockCollapsed(false))
    render(
      <ArtifactWorkspaceDock>
        <div data-testid="chat" />
      </ArtifactWorkspaceDock>
    )
    expect(screen.getByTestId("chat")).toBeInTheDocument()
    expect(screen.getByTestId("dock")).toBeInTheDocument()
    expect(screen.queryByTestId("sheet-panel")).not.toBeInTheDocument()
  })

  it("keeps nothing mounted behind a collapsed dock, but only after it has retracted", async () => {
    jest.useFakeTimers()
    try {
      act(() => useArtifactDockLayoutStore.getState().setDockCollapsed(false))
      render(
        <ArtifactWorkspaceDock>
          <div data-testid="chat" />
        </ArtifactWorkspaceDock>
      )
      expect(screen.getByTestId("dock")).toBeInTheDocument()

      act(() => useArtifactDockLayoutStore.getState().setDockCollapsed(true))

      // Still mounted through the collapse animation: `animateDockResize` pins
      // the content's width so the shrinking shell wipes it, and unmounting on
      // the same frame would leave that 200ms animation wiping a blank box.
      expect(screen.getByTestId("dock")).toBeInTheDocument()

      act(() => jest.advanceTimersByTime(400))

      // Once retracted it must actually go: a zero-width dock used to keep
      // Monaco, the chat pane and the embedded browser alive — and the browser
      // holds a process-wide webview lease released only on unmount.
      expect(screen.queryByTestId("dock")).not.toBeInTheDocument()

      act(() => useArtifactDockLayoutStore.getState().setDockCollapsed(false))
      expect(screen.getByTestId("dock")).toBeInTheDocument()
    } finally {
      jest.useRealTimers()
    }
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

  // Intentional, not an oversight in the breakpoint table: at the 24% narrow
  // preset an 820px tablet gives the dock ~197px, and the workspace profile's
  // 480px floor would claim 59% of the screen. The Sheet hosts the same
  // workbench over the same resource, so this is a different shape rather than
  // a reduced one — asserted here so a future "tablets are wide enough now"
  // change has to be deliberate.
  it("tablet: takes the Sheet, and deliberately not the side-by-side dock", () => {
    useBreakpointMock.mockReturnValue("tablet")
    render(
      <ArtifactWorkspaceDock>
        <div data-testid="chat" />
      </ArtifactWorkspaceDock>
    )
    expect(screen.getByTestId("chat")).toBeInTheDocument()
    expect(screen.getByTestId("sheet-panel")).toBeInTheDocument()
    // The resizable two-column host must be absent, not merely collapsed.
    expect(screen.queryByTestId("artifact-workspace-dock")).not.toBeInTheDocument()
    expect(screen.getByTestId("artifact-workspace-dock-mobile")).toBeInTheDocument()
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
    await waitFor(() => expect(useArtifactDockLayoutStore.getState().mobileSheetOpen).toBe(true))
    expect(useArtifactDockLayoutStore.getState().dockProfile).toBe("workspace")
  })

  it("mobile: a reveal keeps the target it is pointing at", async () => {
    useBreakpointMock.mockReturnValue("mobile")
    render(
      <ArtifactWorkspaceDock>
        <div data-testid="chat" />
      </ArtifactWorkspaceDock>
    )

    act(() => {
      useArtifactDockLayoutStore.getState().revealWorkspaceFile({
        sessionId: SESSION,
        rootPath: "/repo",
        relPath: "src/main.ts",
        line: 12,
      })
    })

    // Two effects here once mirrored `mobileSheetOpen` and `panelOpen` into each
    // other behind identical guards, so a reveal fired both in the same commit:
    // one opened the panel while the other recorded a dismissal and cleared the
    // pending request — the terminal link landed on an empty workspace, and the
    // *next* artifact was suppressed as "already dismissed".
    await waitFor(() => expect(useArtifactDockLayoutStore.getState().mobileSheetOpen).toBe(true))
    const layout = useArtifactDockLayoutStore.getState()
    expect(layout.workspaceRevealRequest).toMatchObject({
      kind: "file",
      relPath: "src/main.ts",
      line: 12,
    })
    expect(layout.workspaceContext).toMatchObject({ kind: "file", relPath: "src/main.ts" })
    expect(layout.userDismissed).toBe(false)
  })

  it("auto-expands the dock when a new artifact becomes active", () => {
    expect(useArtifactDockLayoutStore.getState().dockCollapsed).toBe(true)
    act(() => useArtifactDockLayoutStore.getState().setDockProfile("workspace"))
    const { rerender } = render(
      <ArtifactWorkspaceDock>
        <div data-testid="chat" />
      </ArtifactWorkspaceDock>
    )
    act(() => useArtifactStore.setState({ activeArtifactIdBySession: { [SESSION]: "a-1" } }))
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

  it("persists a workspace-profile drag below the artifact floor", () => {
    // jsdom reports every width as 0, and the workspace floor is only a
    // percentage once the group's width is known.
    const offsetWidth = jest
      .spyOn(HTMLElement.prototype, "offsetWidth", "get")
      .mockReturnValue(2560)
    act(() => {
      useArtifactDockLayoutStore.getState().setDockCollapsed(false)
      useArtifactDockLayoutStore.getState().setDockProfile("workspace")
    })
    render(
      <ArtifactWorkspaceDock>
        <div data-testid="chat" />
      </ArtifactWorkspaceDock>
    )

    // The workspace profile's real floor is an absolute 480px, which on a wide
    // screen is well under the artifact profile's 24%. The old guard rejected
    // anything below 24% outright, so dragging the workspace dock to its own
    // minimum never persisted — and the next collapse/expand restored the stale
    // wider value.
    // 480px of 2560px ≈ 18.75%, so 19% is a legitimate width in this profile.
    act(() => screen.getByTestId("resize-dock-narrow").click())
    expect(useArtifactDockLayoutStore.getState().dockSize).toBe(19)
    offsetWidth.mockRestore()
  })

  it("ignores the collapse itself as a resize", () => {
    act(() => useArtifactDockLayoutStore.getState().setDockCollapsed(false))
    render(
      <ArtifactWorkspaceDock>
        <div data-testid="chat" />
      </ArtifactWorkspaceDock>
    )
    const before = useArtifactDockLayoutStore.getState().dockSize

    act(() => screen.getByTestId("resize-dock-collapsed").click())

    // Collapsing reports 0%; recording it would lose the width to come back to.
    expect(useArtifactDockLayoutStore.getState().dockSize).toBe(before)
  })

  it("double-clicking the divider restores the profile's preset width, animated", () => {
    act(() => {
      useArtifactDockLayoutStore.getState().setDockCollapsed(false)
      useArtifactDockLayoutStore.getState().setDockSize(48)
    })
    render(
      <ArtifactWorkspaceDock>
        <div data-testid="chat" />
      </ArtifactWorkspaceDock>
    )
    const before = useArtifactDockLayoutStore.getState().dockSizeRequest

    act(() => {
      screen
        .getByTestId("resizable-handle")
        .dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))
    })

    const state = useArtifactDockLayoutStore.getState()
    // Compact profile preset (ARTIFACT_DOCK_BOUNDS.default); routed through
    // the request token so it animates like the narrow/wide buttons.
    expect(state.dockSize).toBe(34)
    expect(state.dockSizeRequest).toBe(before + 1)
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

  it("pins the dock body's width so collapsing wipes it instead of squashing it", async () => {
    // jsdom reports every offsetWidth as 0, so the pin is unreachable without
    // stubbing the two measurements it derives from.
    const offsetWidth = jest.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(400)
    try {
      render(
        <ArtifactWorkspaceDock>
          <div data-testid="chat" />
        </ArtifactWorkspaceDock>
      )
      const body = screen.getByTestId("artifact-dock-wrapper")

      act(() => useArtifactDockLayoutStore.getState().setDockCollapsed(false))

      // Expanding: the body is laid out at the width it is heading for (34% of
      // the 400px group) from the first frame, so the widening panel reveals
      // finished content rather than stretching a squeezed column.
      expect(body.style.width).toBe("136px")
      await waitFor(() => expect(body.style.width).toBe(""))

      act(() => useArtifactDockLayoutStore.getState().setDockCollapsed(true))

      // Collapsing: hold what is on screen. The activity rail is shrink-0 while
      // the panel body is not, so an unpinned body gets crushed alone.
      expect(body.style.width).toBe("400px")
      await waitFor(() => expect(body.style.width).toBe(""))
    } finally {
      offsetWidth.mockRestore()
    }
  })

  it("skips the transition and the width pin while a Pro IDE pane is pinned inside", async () => {
    // The embedded code-server pane is a native child webview floating above the
    // DOM. CSS cannot clip it, so the frozen content width below would hold its
    // reserved rect at full size for the whole 200ms — a collapse left a
    // full-width VS Code hanging over the chat before snapping away. And every
    // frame of the transition costs an IPC bounds push plus a VS Code relayout.
    const offsetWidth = jest.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(400)
    try {
      render(
        <ArtifactWorkspaceDock>
          <div data-testid="chat" />
        </ArtifactWorkspaceDock>
      )
      const dockPanel = screen.getByTestId("resizable-panel-artifact-dock")
      const body = screen.getByTestId("artifact-dock-wrapper")

      // Nothing holds the pane yet, so the region alone must not disarm the
      // animation — otherwise the guard would silently kill it for everyone.
      act(() => useArtifactDockLayoutStore.getState().setDockCollapsed(false))
      expect(dockPanel.style.transitionProperty).toBe("flex-grow")
      await waitFor(() => expect(body.style.width).toBe(""))

      await act(async () => {
        await claimCodeServerPane("session:s1", "http://127.0.0.1:1/", RECT, jest.fn())
      })

      act(() => useArtifactDockLayoutStore.getState().setDockCollapsed(true))

      // The size change still lands — it just lands in one frame.
      expect(dockPanel).toHaveAttribute("data-size", "0%")
      expect(dockPanel.style.transitionProperty).toBe("")
      expect(body.style.width).toBe("")

      act(() => useArtifactDockLayoutStore.getState().setDockCollapsed(false))
      expect(dockPanel).toHaveAttribute("data-size", "34%")
      expect(dockPanel.style.transitionProperty).toBe("")
      expect(body.style.width).toBe("")
    } finally {
      offsetWidth.mockRestore()
    }
  })

  it("fades the resize handle in step with the panel instead of hiding it outright", () => {
    render(
      <ArtifactWorkspaceDock>
        <div data-testid="chat" />
      </ArtifactWorkspaceDock>
    )
    const handle = screen.getByTestId("resizable-handle")

    // Collapsed: a hard `hidden` removed the divider before the dock had
    // finished retracting, and popped it back over a zero-width dock on expand.
    expect(handle.className).toContain("opacity-0")
    expect(handle.className).toContain("transition-[width,opacity]")
    expect(handle.className).not.toContain("hidden")

    act(() => useArtifactDockLayoutStore.getState().setDockCollapsed(false))

    expect(handle.className).not.toContain("opacity-0")
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
    act(() => useArtifactStore.setState({ activeArtifactIdBySession: { [SESSION]: "a-new" } }))
    expect(useArtifactDockLayoutStore.getState().dockCollapsed).toBe(true)
    expect(useArtifactDockLayoutStore.getState().unreadArtifact).toBe(true)
  })

  it("mobile: honours a dismissal the same way the desktop dock does", async () => {
    useBreakpointMock.mockReturnValue("mobile")
    render(
      <ArtifactWorkspaceDock>
        <div data-testid="chat" />
      </ArtifactWorkspaceDock>
    )

    // First artifact raises the Sheet.
    act(() => useArtifactStore.setState({ activeArtifactIdBySession: { [SESSION]: "a-1" } }))
    await waitFor(() => expect(useArtifactDockLayoutStore.getState().mobileSheetOpen).toBe(true))

    // Swiping the Sheet away is this platform's dismissal gesture; the host
    // records it through the same collapse the desktop rail uses.
    act(() => useArtifactDockLayoutStore.getState().setDockCollapsed(true))
    await waitFor(() => expect(useArtifactDockLayoutStore.getState().userDismissed).toBe(true))

    // The next artifact must stay out of the way. The auto-expand effect used
    // to live in the desktop branch only, while the Sheet was force-opened from
    // `artifact-store` — which cannot see `userDismissed` — so a phone got the
    // 92dvh modal thrown back over the conversation every single time.
    act(() => useArtifactStore.setState({ activeArtifactIdBySession: { [SESSION]: "a-2" } }))
    expect(useArtifactDockLayoutStore.getState().mobileSheetOpen).toBe(false)
    expect(useArtifactDockLayoutStore.getState().unreadArtifact).toBe(true)

    // ...and the header toggle is the way back in.
    act(() => useArtifactDockLayoutStore.getState().toggleDock())
    await waitFor(() => expect(useArtifactDockLayoutStore.getState().mobileSheetOpen).toBe(true))
    expect(useArtifactDockLayoutStore.getState().unreadArtifact).toBe(false)
  })

  it("raises the dock for an AI revision proposal, on desktop too", () => {
    render(
      <ArtifactWorkspaceDock>
        <div data-testid="chat" />
      </ArtifactWorkspaceDock>
    )
    expect(useArtifactDockLayoutStore.getState().dockCollapsed).toBe(true)

    // A proposal arriving for the already-active artifact leaves
    // `activeArtifactId` untouched, so the artifact signal alone would miss it.
    // Desktop never surfaced this at all — only the mobile Sheet did, by
    // force-opening from the store.
    act(() =>
      useArtifactStore.setState({
        activeArtifactIdBySession: { [SESSION]: "a-1" },
        pendingReviews: { "a-1": { artifactId: "a-1" } as never },
      })
    )

    expect(useArtifactDockLayoutStore.getState().dockCollapsed).toBe(false)
  })
})
