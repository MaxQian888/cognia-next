/** @jest-environment jsdom */

import { act } from "@testing-library/react"
import { getContextWorkbenchWindowScope } from "@/hooks/context-workbench/use-context-workbench-instance-id"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useContextWorkbenchStore } from "@/stores/context-workbench/context-workbench-store"
import {
  parkIdleArtifactDock,
  sessionHoldsArtifacts,
  sessionSurfaceActivePanelId,
} from "./park-idle-dock"
import {
  ARTIFACT_DOCK_WORKBENCH_HOST_KEY,
  SESSION_ARTIFACT_LIST_PANEL_ID,
  sessionWorkbenchScopeKey,
} from "./session-workbench-scope-key"

const SESSION_A = "session-a"
const SESSION_B = "session-b"

function dockScope(sessionId: string | null): string {
  return sessionWorkbenchScopeKey(
    `${getContextWorkbenchWindowScope()}:${ARTIFACT_DOCK_WORKBENCH_HOST_KEY}`,
    sessionId
  )
}

function seedArtifact(sessionId: string): string {
  let id = ""
  act(() => {
    id = useArtifactStore.getState().createArtifact({
      sessionId,
      messageId: `m-${sessionId}`,
      type: "html",
      title: "Page",
      content: "<p>hi</p>",
    }).id
  })
  return id
}

function openDock(): void {
  act(() => useArtifactDockLayoutStore.getState().setDockCollapsed(false))
}

beforeEach(() => {
  act(() => {
    useArtifactDockLayoutStore.getState().resetLayout()
    useContextWorkbenchStore.setState({ layouts: {} })
    useArtifactStore.setState({
      artifacts: {},
      artifactVersions: {},
      pendingReviews: {},
      activeArtifactIdBySession: {},
      openArtifactIdsBySession: {},
    } as never)
  })
})

describe("sessionHoldsArtifacts", () => {
  it("is false for a conversation with nothing recorded, and for no conversation", () => {
    expect(sessionHoldsArtifacts(SESSION_A)).toBe(false)
    expect(sessionHoldsArtifacts(null)).toBe(false)
  })

  it("is true once the conversation owns an artifact, even with no tab open", () => {
    seedArtifact(SESSION_A)
    act(() => {
      useArtifactStore.setState({
        activeArtifactIdBySession: {},
        openArtifactIdsBySession: {},
      } as never)
    })
    expect(sessionHoldsArtifacts(SESSION_A)).toBe(true)
    // Ownership is per conversation — the neighbour is still empty.
    expect(sessionHoldsArtifacts(SESSION_B)).toBe(false)
  })

  it("is true for a proposal awaiting review, which the dock exists to show", () => {
    const id = seedArtifact(SESSION_A)
    act(() => {
      useArtifactStore.setState({
        activeArtifactIdBySession: {},
        openArtifactIdsBySession: {},
        pendingReviews: { [id]: { artifactId: id } },
      } as never)
    })
    expect(sessionHoldsArtifacts(SESSION_A)).toBe(true)
  })
})

describe("sessionSurfaceActivePanelId", () => {
  it("reads the panel the dock's session surface recorded for the conversation", () => {
    expect(sessionSurfaceActivePanelId(SESSION_A)).toBeNull()
    act(() => {
      useContextWorkbenchStore.getState().navigatePanel(dockScope(SESSION_A), "browser", "wide")
    })
    expect(sessionSurfaceActivePanelId(SESSION_A)).toBe("browser")
    // Scoped per conversation, and a dock with no conversation has its own scope.
    expect(sessionSurfaceActivePanelId(SESSION_B)).toBeNull()
    expect(sessionSurfaceActivePanelId(null)).toBeNull()
  })
})

describe("parkIdleArtifactDock", () => {
  it("folds an open dock away when the conversation has no artifacts", () => {
    openDock()
    expect(parkIdleArtifactDock(SESSION_A)).toBe(true)
    const dock = useArtifactDockLayoutStore.getState()
    expect(dock.dockCollapsed).toBe(true)
    // Not a dismissal: the next artifact must still raise the dock.
    expect(dock.userDismissed).toBe(false)
  })

  it("leaves a collapsed dock alone", () => {
    expect(useArtifactDockLayoutStore.getState().dockCollapsed).toBe(true)
    expect(parkIdleArtifactDock(SESSION_A)).toBe(false)
  })

  it("keeps the dock open for a conversation that holds artifacts", () => {
    seedArtifact(SESSION_A)
    openDock()
    expect(parkIdleArtifactDock(SESSION_A)).toBe(false)
    expect(useArtifactDockLayoutStore.getState().dockCollapsed).toBe(false)
  })

  it("keeps a dock the user parked on another panel — that one is not idle", () => {
    openDock()
    act(() => {
      useContextWorkbenchStore.getState().navigatePanel(dockScope(SESSION_A), "browser", "wide")
    })
    expect(parkIdleArtifactDock(SESSION_A)).toBe(false)
    expect(useArtifactDockLayoutStore.getState().dockCollapsed).toBe(false)
  })

  it("treats the artifact-list panel itself as idle", () => {
    openDock()
    act(() => {
      useContextWorkbenchStore
        .getState()
        .navigatePanel(dockScope(SESSION_A), SESSION_ARTIFACT_LIST_PANEL_ID, "narrow")
    })
    expect(parkIdleArtifactDock(SESSION_A)).toBe(true)
    expect(useArtifactDockLayoutStore.getState().dockCollapsed).toBe(true)
  })

  it("parks a dock with no conversation behind it", () => {
    openDock()
    expect(parkIdleArtifactDock(null)).toBe(true)
  })
})
