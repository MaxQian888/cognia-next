/** @jest-environment jsdom */
/**
 * Tests for Artifact Dock Layout Store
 */

import { act, renderHook } from "@testing-library/react"
import {
  ARTIFACT_DOCK_BOUNDS,
  ARTIFACT_DOCK_PERSIST_DEBOUNCE_MS,
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

  describe("defaults", () => {
    it("starts collapsed at the default dock size", () => {
      const { result } = renderHook(() => useArtifactDockLayoutStore())
      expect(result.current.dockSize).toBe(ARTIFACT_DOCK_BOUNDS.default)
      expect(result.current.dockCollapsed).toBe(true)
      expect(result.current.listRailOpen).toBe(false)
      expect(result.current.mobileSheetOpen).toBe(false)
      expect(result.current.dockMode).toBe("artifact")
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

    it("clamps below the min and above the max", () => {
      const { result } = renderHook(() => useArtifactDockLayoutStore())
      act(() => {
        result.current.setDockSize(5)
      })
      expect(result.current.dockSize).toBe(ARTIFACT_DOCK_BOUNDS.min)
      act(() => {
        result.current.setDockSize(99)
      })
      expect(result.current.dockSize).toBe(ARTIFACT_DOCK_BOUNDS.max)
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

  describe("collapse + rail toggles", () => {
    it("toggleDock flips the collapsed flag", () => {
      const { result } = renderHook(() => useArtifactDockLayoutStore())
      act(() => result.current.setDockMode("workspace"))
      act(() => result.current.toggleDock())
      expect(result.current.dockCollapsed).toBe(false)
      expect(result.current.dockMode).toBe("workspace")
      act(() => result.current.toggleDock())
      expect(result.current.dockCollapsed).toBe(true)
      expect(result.current.dockMode).toBe("workspace")
    })

    it("setDockCollapsed accepts explicit values", () => {
      const { result } = renderHook(() => useArtifactDockLayoutStore())
      act(() => result.current.setDockCollapsed(false))
      expect(result.current.dockCollapsed).toBe(false)
    })

    it("toggleListRail / setListRailOpen mutate the rail flag", () => {
      const { result } = renderHook(() => useArtifactDockLayoutStore())
      act(() => result.current.toggleListRail())
      expect(result.current.listRailOpen).toBe(true)
      act(() => result.current.setListRailOpen(false))
      expect(result.current.listRailOpen).toBe(false)
    })
  })

  describe("dock mode + workspace reveal", () => {
    it("migrates a v1 snapshot to artifact mode", async () => {
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

      expect(useArtifactDockLayoutStore.getState().dockMode).toBe("artifact")
      expect(useArtifactDockLayoutStore.getState().dockSize).toBe(41)
    })

    it("persists the selected mode but never the runtime reveal request", () => {
      const { result } = renderHook(() => useArtifactDockLayoutStore())
      act(() => {
        result.current.setDockMode("workspace")
        result.current.revealWorkspaceFile({
          sessionId: "session-1",
          rootPath: "/repo",
          relPath: "src/a.ts",
        })
      })

      expect(result.current.dockMode).toBe("workspace")
      expect(result.current.dockCollapsed).toBe(false)
      expect(result.current.mobileSheetOpen).toBe(true)
      expect(result.current.workspaceRevealRequest).toMatchObject({
        kind: "file",
        sessionId: "session-1",
        rootPath: "/repo",
        relPath: "src/a.ts",
      })
      expect(readPersisted()?.state.dockMode).toBe("workspace")
      expect(readPersisted()?.state).not.toHaveProperty("workspaceRevealRequest")
      expect(readPersisted()?.state).not.toHaveProperty("workspaceContext")
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
        result.current.setListRailOpen(true)
        result.current.setMobileSheetOpen(true)
      })
      act(() => result.current.resetLayout())
      expect(result.current.dockSize).toBe(ARTIFACT_DOCK_BOUNDS.default)
      expect(result.current.dockCollapsed).toBe(true)
      expect(result.current.listRailOpen).toBe(false)
      expect(result.current.mobileSheetOpen).toBe(false)
      expect(result.current.dockMode).toBe("artifact")
      expect(result.current.workspaceRevealRequest).toBeNull()
      expect(result.current.workspaceContext).toBeNull()
      expect(result.current.layoutVersion).toBe(before + 1)
    })
  })
})
