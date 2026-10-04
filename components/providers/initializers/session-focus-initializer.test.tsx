/** @jest-environment jsdom */

import { act, render } from "@testing-library/react"

const migrateConversationState = jest.fn(async () => undefined)
jest.mock("@/lib/connectors/session-bindings", () => ({
  migrateLegacyConversationListState: () => migrateConversationState(),
}))

import { useChatStore } from "@/stores/chat"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"
import { useDockTabsStore } from "@/stores/artifact/dock-tabs-store"
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
  migrateConversationState.mockClear()
  act(() => {
    useDockTabsStore.setState({ bySession: {} })
    useChatStore.getState().clear()
    useArtifactDockLayoutStore.getState().resetLayout()
    useArtifactStore.getState().resetSessionScopedWorkspaceFilters(null)
    // The idle-dock rule reads per-conversation artifact ownership; start empty.
    useArtifactStore.setState({
      artifacts: {},
      artifactVersions: {},
      pendingReviews: {},
      activeArtifactIdBySession: {},
      openArtifactIdsBySession: {},
    } as never)
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

describe("applySessionFocusChange — idle dock", () => {
  it("parks a dock left open by an earlier conversation when the next has no artifacts", () => {
    act(() => useArtifactDockLayoutStore.getState().setDockCollapsed(false))

    act(() => applySessionFocusChange("session-b"))

    const dock = useArtifactDockLayoutStore.getState()
    expect(dock.dockCollapsed).toBe(true)
    // Parked, not dismissed: an artifact arriving in session-b still raises it.
    expect(dock.userDismissed).toBe(false)
  })

  it("follows the user into a conversation that does have artifacts", () => {
    act(() => {
      useArtifactStore.getState().createArtifact({
        sessionId: "session-b",
        messageId: "m-1",
        type: "html",
        title: "Page",
        content: "<p>hi</p>",
      })
      useArtifactDockLayoutStore.getState().setDockCollapsed(false)
    })

    act(() => applySessionFocusChange("session-b"))

    expect(useArtifactDockLayoutStore.getState().dockCollapsed).toBe(false)
  })
})

describe("SessionFocusInitializer", () => {
  it("reconciles legacy Inbox list state once, not on each focus change", () => {
    render(<SessionFocusInitializer />)
    act(() => useChatStore.getState().setActiveSession("next"))
    expect(migrateConversationState).toHaveBeenCalledTimes(1)
  })
  it("parks an idle dock once at mount, for the conversation restored at start-up", () => {
    // `dockCollapsed` is persisted; a reload lands on the restored conversation
    // without passing through a switch, so the seam checks once on mount.
    act(() => {
      useChatStore.getState().setActiveSession("session-a")
      useArtifactDockLayoutStore.getState().setDockCollapsed(false)
    })

    render(<SessionFocusInitializer />)

    expect(useArtifactDockLayoutStore.getState().dockCollapsed).toBe(true)
  })

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

describe("per-task dock memory (ADR-0214, D9)", () => {
  it("gives each conversation back the dock it left", () => {
    render(<SessionFocusInitializer />)
    act(() => useChatStore.getState().setActiveSession("session-a"))
    act(() => useArtifactDockLayoutStore.getState().setDockCollapsed(false))

    act(() => useChatStore.getState().setActiveSession("session-b"))
    // session-b never set one: the idle rule parks the dock.
    expect(useArtifactDockLayoutStore.getState().dockCollapsed).toBe(true)

    act(() => useChatStore.getState().setActiveSession("session-a"))
    expect(useArtifactDockLayoutStore.getState()).toMatchObject({
      dockCollapsed: false,
      userDismissed: false,
    })
    // And session-b remembers it was parked.
    act(() => useChatStore.getState().setActiveSession("session-b"))
    expect(useArtifactDockLayoutStore.getState().dockCollapsed).toBe(true)
  })

  it("restores a dismissal with the closed dock, so a parked artifact does not reopen it", () => {
    render(<SessionFocusInitializer />)
    act(() => useChatStore.getState().setActiveSession("session-a"))
    act(() => useArtifactDockLayoutStore.getState().setDockCollapsed(false))
    act(() => useArtifactDockLayoutStore.getState().setDockCollapsed(true))
    act(() => useChatStore.getState().setActiveSession("session-b"))
    act(() => useArtifactDockLayoutStore.getState().setDockCollapsed(false))

    act(() => useChatStore.getState().setActiveSession("session-a"))
    expect(useArtifactDockLayoutStore.getState()).toMatchObject({
      dockCollapsed: true,
      userDismissed: true,
    })
    // What the dock's attention signal does when a parked artifact shows up.
    act(() => useArtifactDockLayoutStore.getState().notifyNewArtifact())
    expect(useArtifactDockLayoutStore.getState()).toMatchObject({
      dockCollapsed: true,
      unreadArtifact: true,
    })
  })

  it("restores the conversation on screen at start-up without recording the global flag first", () => {
    act(() => {
      useChatStore.getState().setActiveSession("session-a")
      useDockTabsStore.getState().rememberDock("session-a", { open: true, dismissed: false })
      useArtifactDockLayoutStore.getState().setDockCollapsed(true)
    })
    render(<SessionFocusInitializer />)
    expect(useArtifactDockLayoutStore.getState().dockCollapsed).toBe(false)
    expect(useDockTabsStore.getState().bySession["session-a"].dock).toEqual({
      open: true,
      dismissed: false,
    })
  })

  it("never raises the phone Sheet when it restores an open dock", () => {
    render(<SessionFocusInitializer />)
    act(() =>
      useDockTabsStore.getState().rememberDock("session-c", { open: true, dismissed: false })
    )
    act(() => useChatStore.getState().setActiveSession("session-c"))
    expect(useArtifactDockLayoutStore.getState()).toMatchObject({
      dockCollapsed: false,
      mobileSheetOpen: false,
    })
  })

  it("stops recording on unmount", () => {
    const { unmount } = render(<SessionFocusInitializer />)
    act(() => useChatStore.getState().setActiveSession("session-a"))
    unmount()
    act(() => useArtifactDockLayoutStore.getState().setDockCollapsed(false))
    expect(useDockTabsStore.getState().bySession["session-a"]?.dock?.open).not.toBe(true)
  })
})
