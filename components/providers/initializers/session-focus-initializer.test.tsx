/** @jest-environment jsdom */

import { act, render } from "@testing-library/react"

import { useChatStore } from "@/stores/chat"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"
import { SessionFocusInitializer, applySessionFocusChange } from "./session-focus-initializer"

function seedStaleRightRailState(): void {
  act(() => {
    useArtifactDockLayoutStore.getState().revealWorkspaceFile({
      sessionId: "session-a",
      rootPath: "/repo",
      relPath: "src/a.ts",
    })
    useArtifactStore.getState().setArtifactWorkspaceFilters({
      searchQuery: "typed in session-a",
      typeFilter: "html",
      runtimeFilter: "error",
    })
  })
}

beforeEach(() => {
  act(() => {
    useChatStore.getState().clear()
    useArtifactDockLayoutStore.getState().resetLayout()
    useArtifactStore.getState().resetSessionScopedWorkspaceFilters(null)
  })
})

describe("applySessionFocusChange", () => {
  it("drops the pending reveals and the artifact-list narrowing", () => {
    seedStaleRightRailState()

    act(() => applySessionFocusChange("session-b"))

    const dock = useArtifactDockLayoutStore.getState()
    expect(dock.revealIntent).toBeNull()
    expect(dock.workspaceRevealRequest).toBeNull()
    expect(dock.workspaceContext).toBeNull()

    const workspace = useArtifactStore.getState().artifactWorkspace
    expect(workspace.searchQuery).toBe("")
    expect(workspace.typeFilter).toBe("all")
    expect(workspace.runtimeFilter).toBe("all")
    expect(workspace.sessionId).toBe("session-b")
  })
})

describe("SessionFocusInitializer", () => {
  it("runs on every conversation switch", () => {
    render(<SessionFocusInitializer />)
    seedStaleRightRailState()

    act(() => useChatStore.getState().setActiveSession("session-b"))

    expect(useArtifactDockLayoutStore.getState().workspaceContext).toBeNull()
    expect(useArtifactStore.getState().artifactWorkspace.sessionId).toBe("session-b")
  })

  it("ignores chat-store writes that leave the focus alone", () => {
    render(<SessionFocusInitializer />)
    act(() => useChatStore.getState().setActiveSession("session-a"))
    seedStaleRightRailState()

    // A streaming turn writes the chat store constantly; only a *focus* change
    // may wipe the reveal the user is looking at.
    act(() => useChatStore.getState().setStatus("streaming"))

    expect(useArtifactDockLayoutStore.getState().workspaceContext).not.toBeNull()
    expect(useArtifactStore.getState().artifactWorkspace.searchQuery).toBe("typed in session-a")
  })

  it("unsubscribes on unmount", () => {
    const { unmount } = render(<SessionFocusInitializer />)
    unmount()
    seedStaleRightRailState()

    act(() => useChatStore.getState().setActiveSession("session-b"))

    expect(useArtifactDockLayoutStore.getState().workspaceContext).not.toBeNull()
  })
})
