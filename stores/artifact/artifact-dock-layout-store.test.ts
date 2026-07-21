/** @jest-environment jsdom */
/**
 * Tests for Artifact Dock Layout Store
 */

import { act, renderHook } from "@testing-library/react"
import {
  ARTIFACT_DOCK_BOUNDS,
  ARTIFACT_DOCK_PERSIST_DEBOUNCE_MS,
  DOCK_MODE_WIDTH_PERCENT,
  WORKSPACE_DOCK_BOUNDS,
  useArtifactDockLayoutStore,
} from "./artifact-dock-layout-store"

const PERSIST_NAME = "cognia-artifact-dock-layout"

function readPersisted() {
  const raw = window.localStorage.getItem(PERSIST_NAME)
  return raw ? (JSON.parse(raw) as { state: Record<string, unknown> }) : null
}

describe("useArtifactDockLayoutStore", () => {
  beforeEach(() => {
    window.localStorage.clear()
    const { result } = renderHook(() => useArtifactDockLayoutStore())
    act(() => {
      result.current.resetLayout()
    })
  })

  describe("width presets", () => {
    it("maps the workbench modes onto real dock widths, per profile", () => {
      expect(DOCK_MODE_WIDTH_PERCENT.compact.narrow).toBe(ARTIFACT_DOCK_BOUNDS.default)
      expect(DOCK_MODE_WIDTH_PERCENT.compact.wide).toBe(ARTIFACT_DOCK_BOUNDS.max)
      expect(DOCK_MODE_WIDTH_PERCENT.compact.wide).toBeGreaterThan(
        DOCK_MODE_WIDTH_PERCENT.compact.narrow
      )
    })

    it("lets the workspace profile reach its own cap, not the artifact one", () => {
      // A single shared table capped "wide" at 50% even in workspace mode,
      // where the panel allows 65% — the button silently under-delivered.
      expect(DOCK_MODE_WIDTH_PERCENT.workspace.wide).toBe(WORKSPACE_DOCK_BOUNDS.max)
      expect(DOCK_MODE_WIDTH_PERCENT.workspace.wide).toBeGreaterThan(
        DOCK_MODE_WIDTH_PERCENT.compact.wide
      )
      expect(DOCK_MODE_WIDTH_PERCENT.workspace.narrow).toBeGreaterThan(
        DOCK_MODE_WIDTH_PERCENT.compact.narrow
      )
    })

    it("bumps the request token only on an explicit width request", () => {
      const { result } = renderHook(() => useArtifactDockLayoutStore())
      const initialToken = result.current.dockSizeRequest

      // A drag writes the size without asking the dock to resize itself.
      act(() => result.current.setDockSize(45))
      expect(result.current.dockSize).toBe(45)
      expect(result.current.dockSizeRequest).toBe(initialToken)

      act(() => result.current.requestDockSize(DOCK_MODE_WIDTH_PERCENT.compact.wide))
      expect(result.current.dockSize).toBe(DOCK_MODE_WIDTH_PERCENT.compact.wide)
      expect(result.current.dockSizeRequest).toBe(initialToken + 1)
    })

    it("clamps a requested width into the allowed span", () => {
      const { result } = renderHook(() => useArtifactDockLayoutStore())
      act(() => result.current.requestDockSize(5))
      expect(result.current.dockSize).toBe(ARTIFACT_DOCK_BOUNDS.min)

      act(() => result.current.requestDockSize(999))
      expect(result.current.dockSize).toBe(WORKSPACE_DOCK_BOUNDS.max)
    })

    it("never restores the runtime request token from disk", () => {
      const { result } = renderHook(() => useArtifactDockLayoutStore())
      act(() => result.current.requestDockSize(DOCK_MODE_WIDTH_PERCENT.compact.wide))
      expect(readPersisted()?.state.dockSizeRequest).toBeUndefined()
    })
  })

  describe("defaults", () => {
    it("starts collapsed at the default dock size", () => {
      const { result } = renderHook(() => useArtifactDockLayoutStore())
      expect(result.current.dockSize).toBe(ARTIFACT_DOCK_BOUNDS.default)
      expect(result.current.dockCollapsed).toBe(true)
      expect(result.current.mobileSheetOpen).toBe(false)
      expect(result.current.dockProfile).toBe("compact")
      expect(result.current.revealIntent).toBeNull()
      expect(result.current.workspaceRevealRequest).toBeNull()
      expect(result.current.workspaceContext).toBeNull()
    })
  })

  describe("setDockSize", () => {
    it("applies the new size immediately", () => {
      const { result } = renderHook(() => useArtifactDockLayoutStore())
      act(() => {
        result.current.setDockSize(40)
      })
      expect(result.current.dockSize).toBe(40)
    })

    it("clamps below the min and above the workspace max", () => {
      const { result } = renderHook(() => useArtifactDockLayoutStore())
      act(() => {
        result.current.setDockSize(5)
      })
      expect(result.current.dockSize).toBe(ARTIFACT_DOCK_BOUNDS.min)
      // Upper bound spans both modes so a wide workspace size survives; the
      // per-mode artifact cap (50%) is enforced at render by the ResizablePanel.
      act(() => {
        result.current.setDockSize(99)
      })
      expect(result.current.dockSize).toBe(WORKSPACE_DOCK_BOUNDS.max)
    })

    it("falls back to default on non-finite input", () => {
      const { result } = renderHook(() => useArtifactDockLayoutStore())
      act(() => {
        result.current.setDockSize(Number.NaN)
      })
      expect(result.current.dockSize).toBe(ARTIFACT_DOCK_BOUNDS.default)
    })

    it("debounces persistence: rapid drags result in one settled write", () => {
      jest.useFakeTimers()
      const { result } = renderHook(() => useArtifactDockLayoutStore())
      act(() => {
        for (let i = 0; i < 10; i++) {
          result.current.setDockSize(30 + i)
        }
      })
      expect(result.current.dockSize).toBe(39)
      act(() => {
        jest.advanceTimersByTime(ARTIFACT_DOCK_PERSIST_DEBOUNCE_MS + 5)
      })
      expect(readPersisted()?.state.dockSize).toBe(39)
      jest.useRealTimers()
    })
  })

  describe("collapse", () => {
    it("toggleDock flips the collapsed flag without touching the profile", () => {
      const { result } = renderHook(() => useArtifactDockLayoutStore())
      act(() => result.current.setDockProfile("workspace"))
      act(() => result.current.toggleDock())
      expect(result.current.dockCollapsed).toBe(false)
      expect(result.current.dockProfile).toBe("workspace")
      act(() => result.current.toggleDock())
      expect(result.current.dockCollapsed).toBe(true)
      expect(result.current.dockProfile).toBe("workspace")
    })

    it("setDockCollapsed accepts explicit values", () => {
      const { result } = renderHook(() => useArtifactDockLayoutStore())
      act(() => result.current.setDockCollapsed(false))
      expect(result.current.dockCollapsed).toBe(false)
    })
  })

  describe("dismiss + unread artifact", () => {
    it("notifyNewArtifact expands and clears unread when not dismissed", () => {
      const { result } = renderHook(() => useArtifactDockLayoutStore())
      act(() => result.current.notifyNewArtifact())
      expect(result.current.dockCollapsed).toBe(false)
      expect(result.current.unreadArtifact).toBe(false)
      expect(result.current.userDismissed).toBe(false)
    })

    it("manual collapse marks dismissed so a new artifact only flags unread", () => {
      const { result } = renderHook(() => useArtifactDockLayoutStore())
      act(() => result.current.setDockCollapsed(false))
      // User manually collapses the dock.
      act(() => result.current.setDockCollapsed(true))
      expect(result.current.userDismissed).toBe(true)
      // A fresh artifact must NOT yank the dock open — only flag it unread.
      act(() => result.current.notifyNewArtifact())
      expect(result.current.dockCollapsed).toBe(true)
      expect(result.current.unreadArtifact).toBe(true)
    })

    it("re-opening the dock clears the dismissed + unread flags", () => {
      const { result } = renderHook(() => useArtifactDockLayoutStore())
      act(() => result.current.setDockCollapsed(true))
      act(() => result.current.notifyNewArtifact())
      expect(result.current.unreadArtifact).toBe(true)
      act(() => result.current.toggleDock())
      expect(result.current.dockCollapsed).toBe(false)
      expect(result.current.userDismissed).toBe(false)
      expect(result.current.unreadArtifact).toBe(false)
    })

    it("an explicit reveal request clears the unread flag", () => {
      const { result } = renderHook(() => useArtifactDockLayoutStore())
      act(() => result.current.setDockCollapsed(true))
      act(() => result.current.notifyNewArtifact())
      expect(result.current.unreadArtifact).toBe(true)
      act(() => result.current.requestReveal({ panelId: "workspace", mode: "wide" }))
      expect(result.current.unreadArtifact).toBe(false)
    })

    it("never persists the runtime dismiss/unread flags", () => {
      const { result } = renderHook(() => useArtifactDockLayoutStore())
      act(() => result.current.setDockCollapsed(true))
      act(() => result.current.notifyNewArtifact())
      const persisted = JSON.parse(localStorage.getItem(PERSIST_NAME) ?? "{}")
      expect(persisted.state).not.toHaveProperty("userDismissed")
      expect(persisted.state).not.toHaveProperty("unreadArtifact")
    })
  })

  describe("reveal intents + workspace reveal", () => {
    it("opens the browser as a one-shot panel intent, not a persisted mode", () => {
      const { result } = renderHook(() => useArtifactDockLayoutStore())

      act(() => result.current.openBrowser())

      expect(result.current.revealIntent).toEqual({ panelId: "browser", mode: "wide" })
      expect(result.current.dockCollapsed).toBe(false)
      // Routing is never persisted — only the workbench's own layout store
      // remembers which panel a scope was last on.
      expect(readPersisted()?.state).not.toHaveProperty("revealIntent")
    })

    it("consumes an intent only for the panel that actually handled it", () => {
      const { result } = renderHook(() => useArtifactDockLayoutStore())
      act(() => result.current.openBrowser())

      act(() => result.current.consumeRevealIntent("workspace"))
      expect(result.current.revealIntent).toEqual({ panelId: "browser", mode: "wide" })

      act(() => result.current.consumeRevealIntent("browser"))
      expect(result.current.revealIntent).toBeNull()
    })

    it("leaving the workspace profile drops a stale workspace reveal", () => {
      const { result } = renderHook(() => useArtifactDockLayoutStore())
      act(() => result.current.revealWorkspaceReview({ sessionId: "session-1", rootPath: "/repo" }))
      expect(result.current.workspaceContext).not.toBeNull()

      // Re-entering the profile it already owns must NOT wipe the target.
      act(() => result.current.setDockProfile("workspace"))
      expect(result.current.workspaceContext).not.toBeNull()

      act(() => result.current.setDockProfile("compact"))
      expect(result.current.workspaceRevealRequest).toBeNull()
      expect(result.current.workspaceContext).toBeNull()
    })

    it("migrates a v1 snapshot onto the compact profile", async () => {
      window.localStorage.setItem(
        PERSIST_NAME,
        JSON.stringify({
          state: { dockSize: 41, dockCollapsed: false, listRailOpen: true, layoutVersion: 3 },
          version: 1,
        })
      )

      await act(async () => {
        await useArtifactDockLayoutStore.persist.rehydrate()
      })

      expect(useArtifactDockLayoutStore.getState().dockProfile).toBe("compact")
      expect(useArtifactDockLayoutStore.getState().dockSize).toBe(41)
    })

    it("persists the sizing profile but never the runtime reveal request", () => {
      const { result } = renderHook(() => useArtifactDockLayoutStore())
      act(() => {
        result.current.revealWorkspaceFile({
          sessionId: "session-1",
          rootPath: "/repo",
          relPath: "src/a.ts",
          line: 12,
          column: 4,
        })
      })

      expect(result.current.dockProfile).toBe("workspace")
      expect(result.current.dockCollapsed).toBe(false)
      expect(result.current.mobileSheetOpen).toBe(true)
      expect(result.current.workspaceRevealRequest).toMatchObject({
        kind: "file",
        sessionId: "session-1",
        rootPath: "/repo",
        relPath: "src/a.ts",
        line: 12,
        column: 4,
      })
      expect(readPersisted()?.state.dockProfile).toBe("workspace")
      expect(readPersisted()?.state).not.toHaveProperty("workspaceRevealRequest")
      expect(readPersisted()?.state).not.toHaveProperty("workspaceContext")
    })

    it.each([
      ["workspace", "workspace"],
      ["browser", "compact"],
      ["artifact", "compact"],
    ])("migrates a v2 dockMode %s onto the %s profile", async (dockMode, dockProfile) => {
      // Only the *sizing* meaning of the old three-value mode survives:
      // `workspace` was the one value that changed the dock's min/max bounds.
      window.localStorage.setItem(
        PERSIST_NAME,
        JSON.stringify({
          state: { dockSize: 38, dockCollapsed: false, dockMode, layoutVersion: 2 },
          version: 2,
        })
      )

      await act(async () => {
        await useArtifactDockLayoutStore.persist.rehydrate()
      })

      expect(useArtifactDockLayoutStore.getState().dockProfile).toBe(dockProfile)
      expect(useArtifactDockLayoutStore.getState().dockSize).toBe(38)
      expect(useArtifactDockLayoutStore.getState()).not.toHaveProperty("dockMode")
    })

    it("queues review reveals and lets the consumer clear only the matching request", () => {
      const { result } = renderHook(() => useArtifactDockLayoutStore())
      act(() => {
        result.current.revealWorkspaceReview({ sessionId: "session-2", rootPath: "/repo" })
      })
      const request = result.current.workspaceRevealRequest
      expect(request).toMatchObject({ kind: "review", sessionId: "session-2", rootPath: "/repo" })
      expect(result.current.mobileSheetOpen).toBe(true)

      act(() => result.current.clearWorkspaceRevealRequest("stale"))
      expect(result.current.workspaceRevealRequest).toBe(request)
      act(() => result.current.clearWorkspaceRevealRequest(request!.id))
      expect(result.current.workspaceRevealRequest).toBeNull()
      expect(result.current.workspaceContext).toMatchObject({
        kind: "review",
        sessionId: "session-2",
        rootPath: "/repo",
      })
    })
  })

  describe("mobileSheetOpen", () => {
    it("mutates runtime state", () => {
      const { result } = renderHook(() => useArtifactDockLayoutStore())
      act(() => result.current.setMobileSheetOpen(true))
      expect(result.current.mobileSheetOpen).toBe(true)
    })

    it("atomically clears the Workspace target when closing", () => {
      const { result } = renderHook(() => useArtifactDockLayoutStore())
      act(() => {
        result.current.revealWorkspaceFile({
          sessionId: "session-1",
          rootPath: "/repo",
          relPath: "src/a.ts",
        })
        result.current.setMobileSheetOpen(false)
      })

      expect(result.current.mobileSheetOpen).toBe(false)
      expect(result.current.workspaceRevealRequest).toBeNull()
      expect(result.current.workspaceContext).toBeNull()
    })

    it("is excluded from the persisted snapshot", () => {
      jest.useFakeTimers()
      const { result } = renderHook(() => useArtifactDockLayoutStore())
      act(() => {
        result.current.setMobileSheetOpen(true)
        result.current.setDockSize(35)
        jest.advanceTimersByTime(ARTIFACT_DOCK_PERSIST_DEBOUNCE_MS + 5)
      })
      expect(readPersisted()?.state).not.toHaveProperty("mobileSheetOpen")
      jest.useRealTimers()
    })
  })

  describe("resetLayout", () => {
    it("returns to defaults and bumps layoutVersion", () => {
      const { result } = renderHook(() => useArtifactDockLayoutStore())
      const before = result.current.layoutVersion
      act(() => {
        result.current.setDockSize(48)
        result.current.setDockCollapsed(false)
        result.current.setDockProfile("workspace")
        result.current.setMobileSheetOpen(true)
      })
      act(() => result.current.resetLayout())
      expect(result.current.dockSize).toBe(ARTIFACT_DOCK_BOUNDS.default)
      expect(result.current.dockCollapsed).toBe(true)
      expect(result.current.mobileSheetOpen).toBe(false)
      expect(result.current.dockProfile).toBe("compact")
      expect(result.current.revealIntent).toBeNull()
      expect(result.current.workspaceRevealRequest).toBeNull()
      expect(result.current.workspaceContext).toBeNull()
      expect(result.current.layoutVersion).toBe(before + 1)
    })
  })
})
