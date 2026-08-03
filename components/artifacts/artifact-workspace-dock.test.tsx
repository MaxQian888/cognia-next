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

  // Shared between the mock group and the mock panel so a test can reproduce
  // the real library's own behaviour: "a collapsible panel will collapse when
  // its size is less than `minSize`". That happens *inside* the drag, with no
  // imperative call — which is exactly the case the dock used to miss.
  const collapsedByDrag: Record<string, boolean> = {}

  return {
    __setCollapsedByDrag: (id: string, value: boolean) => {
      collapsedByDrag[id] = value
    },
    ResizablePanelGroup: ({
      children,
      onLayoutChanged,
      resizeTargetMinimumSize,
    }: {
      children: React.ReactNode
      onLayoutChanged?: (layout: Record<string, number>) => void
      resizeTargetMinimumSize?: { coarse: number; fine: number }
    }) => (
      <div
        data-testid="resizable-panel-group"
        data-resize-target-coarse={resizeTargetMinimumSize?.coarse}
        data-resize-target-fine={resizeTargetMinimumSize?.fine}
      >
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
        {/* What the real library does on its own when a drag crosses `minSize`:
            the panel is already collapsed by the time the layout is reported. */}
        <button
          type="button"
          data-testid="drag-dock-shut"
          onClick={() => {
            collapsedByDrag["artifact-dock"] = true
            onLayoutChanged?.({ "artifact-dock": 3.75 })
          }}
        />
        {/* Mid-drag layout reports at the widths the release-snap tests need.
            The real divider produces a stream of these; one is enough to leave
            the dock at a given width when the pointer comes up. */}
        {[10, 25, 35.5, 42].map((percent) => (
          <button
            key={percent}
            type="button"
            data-testid={`resize-dock-to-${percent}`}
            onClick={() => onLayoutChanged?.({ "artifact-dock": percent })}
          />
        ))}
      </div>
    ),
    ResizablePanel: ({
      children,
      id,
      defaultSize,
      minSize,
      maxSize,
      collapsedSize,
      elementRef,
      panelRef,
    }: {
      children: React.ReactNode
      id: string
      defaultSize?: number | string
      minSize?: number | string
      maxSize?: number | string
      // Mirrors the real prop: the size a collapse settles at. Hardcoding "0%"
      // here would have hidden the persistent rail entirely — the dock now
      // collapses to the rail's width, not to nothing.
      collapsedSize?: number | string
      elementRef?: React.Ref<HTMLDivElement>
      panelRef?: React.Ref<MockPanelHandle>
    }) => {
      const [size, setSize] = useState(defaultSize)
      const shut = collapsedSize ?? "0%"
      const collapsedRef = useRef(defaultSize === shut)
      useImperativeHandle(panelRef, () => ({
        collapse: () => {
          collapsedByDrag[id] = false
          collapsedRef.current = true
          setSize(shut)
        },
        expand: () => {
          collapsedByDrag[id] = false
          collapsedRef.current = false
          setSize(defaultSize)
        },
        getSize: () => ({ asPercentage: 0, inPixels: 0 }),
        isCollapsed: () => collapsedByDrag[id] || collapsedRef.current,
        resize: (nextSize) => {
          collapsedByDrag[id] = false
          collapsedRef.current = nextSize === 0 || nextSize === shut
          setSize(nextSize)
        },
      }))
      return (
        <div
          ref={elementRef}
          data-panel=""
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
      // Forwarded because the release-snap hangs off them: the divider decides
      // where the panel lands on `pointerup`, reading whether the drag began
      // from the rail on `pointerdown`.
      onPointerDown,
      onPointerUp,
    }: {
      className?: string
      onDoubleClick?: () => void
      onPointerDown?: () => void
      onPointerUp?: () => void
    }) => (
      <div
        data-separator=""
        data-testid="resizable-handle"
        className={className}
        onDoubleClick={onDoubleClick}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
      />
    ),
  }
})

// Renders the Pro IDE reserved-region marker the real dock tree carries when
// CodeServerPane is mounted. Harmless for every other test: the region only
// counts as "pinned" once a surface has actually claimed the native pane.
// Literal attribute name rather than the imported constant — a jest.mock
// factory referencing a module-scope import hits the TDZ trap.
jest.mock("./artifact-dock", () => ({
  ArtifactDock: ({ railOnly }: { railOnly?: boolean }) => (
    <div data-testid="dock" data-rail-only={railOnly ? "true" : undefined} data-pro-ide-region="" />
  ),
}))

jest.mock("./artifact-panel", () => ({
  ArtifactPanel: () => <div data-testid="sheet-panel" />,
}))
jest.mock("./workspace-mode/workspace-reveal-opener", () => ({
  WorkspaceRevealOpener: () => <div data-testid="workspace-reveal-opener" />,
}))

import {
  ArtifactWorkspaceDock,
  DOCK_RESIZE_DURATION_MS,
  DOCK_RESIZE_EASE,
} from "./artifact-workspace-dock"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { MOBILE_DURATION, MOBILE_EASE } from "@/lib/ui/motion"
import { useBreakpoint } from "@/hooks/ui"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"
import { useChatStore } from "@/stores/chat"
import { useSettingsStore } from "@/stores/settings/settings-store"

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
  // The persistent rail is a settings field defaulting to on; start every test
  // from a clean settings object so one that switches it off cannot leak.
  useSettingsStore.setState({ settings: {} as never })
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

  it("drops the panel body behind a collapsed dock, but only after it has retracted", async () => {
    jest.useFakeTimers()
    try {
      act(() => useArtifactDockLayoutStore.getState().setDockCollapsed(false))
      render(
        <ArtifactWorkspaceDock>
          <div data-testid="chat" />
        </ArtifactWorkspaceDock>
      )
      expect(screen.getByTestId("dock")).not.toHaveAttribute("data-rail-only")

      act(() => useArtifactDockLayoutStore.getState().setDockCollapsed(true))

      // Still showing its body through the collapse animation: the old view
      // snapshot needs real content, and dropping it on the same frame would
      // capture a blank box moving into the activity rail.
      expect(screen.getByTestId("dock")).not.toHaveAttribute("data-rail-only")

      act(() => jest.advanceTimersByTime(400))

      // Once retracted the body must actually go: a zero-width dock used to keep
      // Monaco, the chat pane and the embedded browser alive — and the browser
      // holds a process-wide webview lease released only on unmount. The shell
      // itself stays so the activity rail can keep drawing.
      expect(screen.getByTestId("dock")).toHaveAttribute("data-rail-only", "true")

      act(() => useArtifactDockLayoutStore.getState().setDockCollapsed(false))
      expect(screen.getByTestId("dock")).not.toHaveAttribute("data-rail-only")
    } finally {
      jest.useRealTimers()
    }
  })

  it("unmounts the dock entirely when the persistent rail is switched off", async () => {
    jest.useFakeTimers()
    try {
      useSettingsStore.setState({ settings: { workbenchRailPersistent: false } as never })
      act(() => useArtifactDockLayoutStore.getState().setDockCollapsed(false))
      render(
        <ArtifactWorkspaceDock>
          <div data-testid="chat" />
        </ArtifactWorkspaceDock>
      )
      expect(screen.getByTestId("dock")).toBeInTheDocument()

      act(() => useArtifactDockLayoutStore.getState().setDockCollapsed(true))
      act(() => jest.advanceTimersByTime(400))

      // No rail to keep on screen, so the pre-minibar contract holds: nothing
      // survives behind a dock collapsed to zero width.
      expect(screen.queryByTestId("dock")).not.toBeInTheDocument()
      expect(screen.getByTestId("resizable-panel-artifact-dock")).toHaveAttribute("data-size", "0%")
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

  it("records a drag that shut the dock, so the next toggle is not a dead press", () => {
    act(() => useArtifactDockLayoutStore.getState().setDockCollapsed(false))
    render(
      <ArtifactWorkspaceDock>
        <div data-testid="chat" />
      </ArtifactWorkspaceDock>
    )

    // `react-resizable-panels` collapses the panel itself once a drag crosses
    // `minSize`. Nothing used to write that back, so the dock sat visually shut
    // while the store still said "open" — and the next ⌘J / header toggle /
    // Views-menu press spent itself collapsing an already-collapsed panel and
    // looked broken. Only the second press did anything.
    act(() => screen.getByTestId("drag-dock-shut").click())

    expect(useArtifactDockLayoutStore.getState().dockCollapsed).toBe(true)
    // The width the drag passed through is not persisted as a real width — it
    // is the collapse itself.
    expect(useArtifactDockLayoutStore.getState().dockSize).toBe(34)

    act(() => useArtifactDockLayoutStore.getState().toggleDock())
    expect(useArtifactDockLayoutStore.getState().dockCollapsed).toBe(false)
  })

  describe("release snap", () => {
    // The magnet is a physical 24px, so it only becomes a percentage once the
    // group has measured. jsdom reports every width as 0.
    function withGroupWidth(px: number) {
      return jest.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(px)
    }

    function dragTo(percent: number) {
      const handle = screen.getByTestId("resizable-handle")
      act(() => handle.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })))
      act(() => screen.getByTestId(`resize-dock-to-${percent}`).click())
      act(() => handle.dispatchEvent(new MouseEvent("pointerup", { bubbles: true })))
    }

    it("clicks a drop near a width preset into place", () => {
      const offsetWidth = withGroupWidth(1280)
      act(() => useArtifactDockLayoutStore.getState().setDockCollapsed(false))
      render(
        <ArtifactWorkspaceDock>
          <div data-testid="chat" />
        </ArtifactWorkspaceDock>
      )

      // 35.5% sits 1.5% from the compact profile's narrow preset (34%), which on
      // a 1280px group is 19px — inside the 24px magnet.
      dragTo(35.5)

      expect(useArtifactDockLayoutStore.getState().dockSize).toBe(34)
      offsetWidth.mockRestore()
    })

    it("leaves a deliberate width where the user put it", () => {
      const offsetWidth = withGroupWidth(1280)
      act(() => useArtifactDockLayoutStore.getState().setDockCollapsed(false))
      render(
        <ArtifactWorkspaceDock>
          <div data-testid="chat" />
        </ArtifactWorkspaceDock>
      )

      dragTo(42)

      expect(useArtifactDockLayoutStore.getState().dockSize).toBe(42)
      offsetWidth.mockRestore()
    })

    it("reopens to the remembered width when the drag starts from the rail", () => {
      const offsetWidth = withGroupWidth(1280)
      act(() => {
        useArtifactDockLayoutStore.getState().setDockSize(45)
        useArtifactDockLayoutStore.getState().setDockCollapsed(true)
      })
      render(
        <ArtifactWorkspaceDock>
          <div data-testid="chat" />
        </ArtifactWorkspaceDock>
      )
      expect(useArtifactDockLayoutStore.getState().dockCollapsed).toBe(true)

      // Barely clearing the floor still means "put it back", not "settle here".
      dragTo(25)

      const state = useArtifactDockLayoutStore.getState()
      expect(state.dockCollapsed).toBe(false)
      expect(state.dockSize).toBe(45)
      offsetWidth.mockRestore()
    })

    it("stays on the rail when the drag never clears the floor", () => {
      const offsetWidth = withGroupWidth(1280)
      act(() => useArtifactDockLayoutStore.getState().setDockCollapsed(true))
      render(
        <ArtifactWorkspaceDock>
          <div data-testid="chat" />
        </ArtifactWorkspaceDock>
      )

      dragTo(10)

      expect(useArtifactDockLayoutStore.getState().dockCollapsed).toBe(true)
      offsetWidth.mockRestore()
    })
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

  it("uses one snapshot transition for a preset instead of reflowing the live page", async () => {
    act(() => useArtifactDockLayoutStore.getState().setDockCollapsed(false))
    let finishTransition: (() => void) | undefined
    const skipTransition = jest.fn()
    const startViewTransition = jest.fn((update: () => void) => {
      update()
      return {
        ready: Promise.resolve(),
        updateCallbackDone: Promise.resolve(),
        finished: new Promise<void>((resolve) => {
          finishTransition = resolve
        }),
        skipTransition,
      }
    })
    Object.defineProperty(document, "startViewTransition", {
      configurable: true,
      value: startViewTransition,
    })

    try {
      render(
        <ArtifactWorkspaceDock>
          <div data-testid="chat" />
        </ArtifactWorkspaceDock>
      )
      const dockPanel = screen.getByTestId("resizable-panel-artifact-dock")
      const chatPanel = screen.getByTestId("resizable-panel-artifact-chat")
      const divider = screen.getByTestId("resizable-handle")

      act(() => useArtifactDockLayoutStore.getState().requestDockSize(50))

      expect(startViewTransition).toHaveBeenCalledTimes(1)
      expect(dockPanel).toHaveAttribute("data-size", "50%")
      expect(dockPanel.style.transitionProperty).toBe("")
      expect(dockPanel.style.viewTransitionName).toBe("cognia-dock-panel")
      expect(chatPanel.style.viewTransitionName).toBe("cognia-dock-chat")
      expect(divider.style.viewTransitionName).toBe("cognia-dock-divider")
      expect(document.documentElement.style.viewTransitionName).toBe("none")

      finishTransition?.()
      await waitFor(() => expect(dockPanel.style.viewTransitionName).toBe(""))
      expect(chatPanel.style.viewTransitionName).toBe("")
      expect(divider.style.viewTransitionName).toBe("")
      expect(document.documentElement.style.viewTransitionName).toBe("")
      expect(skipTransition).not.toHaveBeenCalled()
    } finally {
      Reflect.deleteProperty(document, "startViewTransition")
      document.documentElement.style.viewTransitionName = ""
    }
  })

  it("falls back to an immediate stable resize when snapshot transitions are unavailable", () => {
    render(
      <ArtifactWorkspaceDock>
        <div data-testid="chat" />
      </ArtifactWorkspaceDock>
    )

    // Collapsed means "shrunk to the activity rail", not "gone" — the rail is
    // what keeps the right-hand panels discoverable.
    expect(screen.getByTestId("resizable-panel-artifact-dock")).toHaveAttribute("data-size", "48px")

    act(() => useArtifactDockLayoutStore.getState().setDockCollapsed(false))
    const dockPanel = screen.getByTestId("resizable-panel-artifact-dock")
    expect(dockPanel).toHaveAttribute("data-size", "34%")
    // Replaying a live flex transition would reflow the chat on every frame.
    // An engine without View Transitions takes the correct final layout once.
    expect(dockPanel.style.transitionProperty).toBe("")
    expect(screen.getByTestId("artifact-dock-wrapper").style.width).toBe("")

    act(() => useArtifactDockLayoutStore.getState().setDockCollapsed(true))
    expect(dockPanel).toHaveAttribute("data-size", "48px")
    expect(dockPanel.style.transitionProperty).toBe("")
  })

  it("falls back cleanly when the resizable group cannot provide snapshot surfaces", () => {
    act(() => useArtifactDockLayoutStore.getState().setDockCollapsed(false))
    const startViewTransition = jest.fn()
    Object.defineProperty(document, "startViewTransition", {
      configurable: true,
      value: startViewTransition,
    })
    try {
      const { unmount } = render(
        <ArtifactWorkspaceDock>
          <div data-testid="chat" />
        </ArtifactWorkspaceDock>
      )
      screen.getByTestId("resizable-handle").removeAttribute("data-separator")

      act(() => useArtifactDockLayoutStore.getState().requestDockSize(50))

      expect(screen.getByTestId("resizable-panel-artifact-dock")).toHaveAttribute(
        "data-size",
        "50%"
      )
      expect(startViewTransition).not.toHaveBeenCalled()
      unmount()
    } finally {
      Reflect.deleteProperty(document, "startViewTransition")
    }
  })

  it("lands the requested layout if snapshot capture throws", () => {
    act(() => useArtifactDockLayoutStore.getState().setDockCollapsed(false))
    const startViewTransition = jest.fn(() => {
      throw new Error("snapshot unavailable")
    })
    Object.defineProperty(document, "startViewTransition", {
      configurable: true,
      value: startViewTransition,
    })
    try {
      const { unmount } = render(
        <ArtifactWorkspaceDock>
          <div data-testid="chat" />
        </ArtifactWorkspaceDock>
      )

      act(() => useArtifactDockLayoutStore.getState().requestDockSize(50))

      const dockPanel = screen.getByTestId("resizable-panel-artifact-dock")
      expect(dockPanel).toHaveAttribute("data-size", "50%")
      expect(dockPanel.style.viewTransitionName).toBe("")
      expect(document.documentElement.style.viewTransitionName).toBe("")
      unmount()
    } finally {
      Reflect.deleteProperty(document, "startViewTransition")
      document.documentElement.style.viewTransitionName = ""
    }
  })

  it("uses the same snapshot path for collapse and expand", async () => {
    const transitions: Array<{ finish: () => void }> = []
    const startViewTransition = jest.fn((update: () => void) => {
      update()
      let finish = () => {}
      const finished = new Promise<void>((resolve) => {
        finish = resolve
      })
      transitions.push({ finish })
      return {
        ready: Promise.resolve(),
        updateCallbackDone: Promise.resolve(),
        finished,
        skipTransition: jest.fn(),
      }
    })
    Object.defineProperty(document, "startViewTransition", {
      configurable: true,
      value: startViewTransition,
    })
    try {
      render(
        <ArtifactWorkspaceDock>
          <div data-testid="chat" />
        </ArtifactWorkspaceDock>
      )
      const panel = screen.getByTestId("resizable-panel-artifact-dock")

      act(() => useArtifactDockLayoutStore.getState().setDockCollapsed(false))
      expect(panel).toHaveAttribute("data-size", "34%")
      expect(startViewTransition).toHaveBeenCalledTimes(1)
      transitions[0]?.finish()
      await waitFor(() => expect(panel.style.viewTransitionName).toBe(""))

      act(() => useArtifactDockLayoutStore.getState().setDockCollapsed(true))
      expect(panel).toHaveAttribute("data-size", "48px")
      expect(startViewTransition).toHaveBeenCalledTimes(2)
      expect(screen.getByTestId("artifact-dock-wrapper").style.width).toBe("")
    } finally {
      Reflect.deleteProperty(document, "startViewTransition")
      document.documentElement.style.viewTransitionName = ""
    }
  })

  it("keeps responsive content untouched while a width preset shrinks the dock", () => {
    act(() => {
      useArtifactDockLayoutStore.getState().setDockCollapsed(false)
      useArtifactDockLayoutStore.getState().setDockSize(50)
    })
    const startViewTransition = jest.fn((update: () => void) => {
      update()
      return {
        ready: Promise.resolve(),
        updateCallbackDone: Promise.resolve(),
        finished: new Promise<void>(() => {}),
        skipTransition: jest.fn(),
      }
    })
    Object.defineProperty(document, "startViewTransition", {
      configurable: true,
      value: startViewTransition,
    })
    try {
      render(
        <ArtifactWorkspaceDock>
          <div data-testid="chat" />
        </ArtifactWorkspaceDock>
      )
      const body = screen.getByTestId("artifact-dock-wrapper")

      act(() => useArtifactDockLayoutStore.getState().requestDockSize(34))

      // The browser owns old/new snapshots; the live body is never forced to a
      // guessed pixel width that can disagree with the panel's final flex math.
      expect(startViewTransition).toHaveBeenCalledTimes(1)
      expect(body.style.width).toBe("")
    } finally {
      Reflect.deleteProperty(document, "startViewTransition")
      document.documentElement.style.viewTransitionName = ""
    }
  })

  it("skips the snapshot transition while a Pro IDE pane is pinned inside", async () => {
    // The embedded code-server pane is a native child webview floating above the
    // DOM. A browser snapshot cannot capture it, and moving the reserved region
    // underneath would leave a full-width VS Code view hanging over the chat
    // before snapping away.
    const startViewTransition = jest.fn((update: () => void) => {
      update()
      return {
        ready: Promise.resolve(),
        updateCallbackDone: Promise.resolve(),
        finished: Promise.resolve(),
        skipTransition: jest.fn(),
      }
    })
    Object.defineProperty(document, "startViewTransition", {
      configurable: true,
      value: startViewTransition,
    })
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
      expect(startViewTransition).toHaveBeenCalledTimes(1)
      await waitFor(() => expect(dockPanel.style.viewTransitionName).toBe(""))

      await act(async () => {
        await claimCodeServerPane("session:s1", "http://127.0.0.1:1/", RECT, jest.fn())
      })

      act(() => useArtifactDockLayoutStore.getState().setDockCollapsed(true))

      // The size change still lands — it just lands in one frame.
      expect(dockPanel).toHaveAttribute("data-size", "48px")
      expect(startViewTransition).toHaveBeenCalledTimes(1)
      expect(dockPanel.style.transitionProperty).toBe("")
      expect(body.style.width).toBe("")

      act(() => useArtifactDockLayoutStore.getState().setDockCollapsed(false))
      expect(dockPanel).toHaveAttribute("data-size", "34%")
      expect(startViewTransition).toHaveBeenCalledTimes(1)
      expect(dockPanel.style.transitionProperty).toBe("")
      expect(body.style.width).toBe("")
    } finally {
      Reflect.deleteProperty(document, "startViewTransition")
      document.documentElement.style.viewTransitionName = ""
    }
  })

  it("fades the resize handle in step with the panel instead of hiding it outright", () => {
    render(
      <ArtifactWorkspaceDock>
        <div data-testid="chat" />
      </ArtifactWorkspaceDock>
    )
    const handle = screen.getByTestId("resizable-handle")

    // Over a persistent rail the divider stays fully live even while collapsed:
    // dragging this edge outward is the gesture that opens the minibar, so
    // fading or disabling it here would make that impossible.
    expect(handle.className).not.toContain("opacity-0")
    expect(handle.className).toContain("transition-[width,opacity]")
    expect(handle.className).toContain("after:w-5")
    expect(handle.className).toContain("z-20")
    expect(handle.className).not.toContain("hidden")
    expect(screen.getByTestId("resizable-panel-group")).toHaveAttribute(
      "data-resize-target-coarse",
      "28"
    )
    expect(screen.getByTestId("resizable-panel-group")).toHaveAttribute(
      "data-resize-target-fine",
      "20"
    )

    act(() => useArtifactDockLayoutStore.getState().setDockCollapsed(false))

    expect(handle.className).not.toContain("opacity-0")
  })

  it("fades the divider away only when there is no rail left to drag", () => {
    useSettingsStore.setState({ settings: { workbenchRailPersistent: false } as never })
    render(
      <ArtifactWorkspaceDock>
        <div data-testid="chat" />
      </ArtifactWorkspaceDock>
    )
    const handle = screen.getByTestId("resizable-handle")

    // Collapsed to zero: a hard `hidden` removed the divider before the dock had
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

  it("lets a width request outrank a sizing profile that has not caught up", () => {
    render(
      <ArtifactWorkspaceDock>
        <div data-testid="chat" />
      </ArtifactWorkspaceDock>
    )

    // `dockProfile` is written by `useDockPanelSync` in an effect that runs
    // *after* the activation which asked for the width, so a workspace panel
    // requests 65% while the profile still reads `compact` (50% cap, 50% chat
    // floor). Clamping there left the workspace panel at the artifact width and
    // landed the clamp as a second, untransitioned layout pass.
    act(() => useArtifactDockLayoutStore.getState().requestDockSize(65))

    expect(useArtifactDockLayoutStore.getState().dockProfile).toBe("compact")
    expect(screen.getByTestId("resizable-panel-artifact-dock")).toHaveAttribute("data-max", "65%")
    expect(screen.getByTestId("resizable-panel-artifact-chat")).toHaveAttribute("data-min", "35%")
  })

  it("keeps one snapshot transition alive when layout echoes the settled width back", () => {
    const startViewTransition = jest.fn((update: () => void) => {
      update()
      return {
        ready: Promise.resolve(),
        updateCallbackDone: Promise.resolve(),
        finished: new Promise<void>(() => {}),
        skipTransition: jest.fn(),
      }
    })
    Object.defineProperty(document, "startViewTransition", {
      configurable: true,
      value: startViewTransition,
    })
    try {
      render(
        <ArtifactWorkspaceDock>
          <div data-testid="chat" />
        </ArtifactWorkspaceDock>
      )
      act(() => useArtifactDockLayoutStore.getState().setDockCollapsed(false))
      const panel = screen.getByTestId("resizable-panel-artifact-dock")
      const body = screen.getByTestId("artifact-dock-wrapper")

      const requestsBefore = startViewTransition.mock.calls.length
      act(() => useArtifactDockLayoutStore.getState().requestDockSize(50))
      expect(startViewTransition).toHaveBeenCalledTimes(requestsBefore + 1)
      expect(panel.style.viewTransitionName).toBe("cognia-dock-panel")

      // `onLayoutChanged` reports a pixel measurement converted back to a
      // percent, so it practically never equals the number that was requested.
      // That echo used to be a dependency of the animation effect: React ran
      // its cleanup mid-flight and the re-run bailed on the unchanged request
      // token instead of restarting the motion. Keep the one capture active so
      // responsive contents never flash into the live page between snapshots.
      act(() => screen.getByTestId("resize-dock").click())

      expect(useArtifactDockLayoutStore.getState().dockSize).toBe(42)
      expect(body.style.width).toBe("")
      expect(panel.style.viewTransitionName).toBe("cognia-dock-panel")
      expect(startViewTransition).toHaveBeenCalledTimes(requestsBefore + 1)
    } finally {
      Reflect.deleteProperty(document, "startViewTransition")
      document.documentElement.style.viewTransitionName = ""
    }
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

describe("dock motion tokens", () => {
  it("takes its duration and curve from the shared motion tokens", () => {
    expect(DOCK_RESIZE_DURATION_MS).toBe(MOBILE_DURATION.normal * 1000)
    expect(DOCK_RESIZE_EASE).toBe(`cubic-bezier(${MOBILE_EASE.join(",")})`)
  })

  it("keeps the snapshot CSS and divider's literal class in step with them", () => {
    // The snapshot groups and divider move as one gesture, but their CSS
    // literals cannot interpolate TypeScript constants. Assert they agree so
    // the boundary never outruns either panel capture.
    const source = readFileSync(join(__dirname, "artifact-workspace-dock.tsx"), "utf8")
    const globalStyles = readFileSync(join(__dirname, "../../app/globals.css"), "utf8")
    expect(source).toContain(
      `duration-[calc(${DOCK_RESIZE_DURATION_MS}ms*var(--motion-duration-scale,1))]`
    )
    expect(source).toContain(`ease-[${DOCK_RESIZE_EASE}]`)
    expect(globalStyles).toContain(
      `animation-duration: calc(${DOCK_RESIZE_DURATION_MS}ms * var(--motion-duration-scale, 1))`
    )
    expect(globalStyles.replaceAll(/\s/g, "")).toContain(
      `animation-timing-function:${DOCK_RESIZE_EASE}`
    )
    expect(globalStyles).toContain("object-position: left center")
    expect(globalStyles).toContain("object-position: right center")
  })
})
