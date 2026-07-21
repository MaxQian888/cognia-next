/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, act } from "@testing-library/react"

let workspaceAvailable = true

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("./artifact-panel-content", () => ({
  ArtifactPanelContent: ({ panelMode }: { panelMode: string }) => (
    <div data-testid="panel-content" data-mode={panelMode} />
  ),
}))

jest.mock("@/components/context-workbench/resource-workbench-chat-panel", () => ({
  ResourceWorkbenchChatPanel: ({ pendingPrompt }: { pendingPrompt?: string | null }) => (
    <div data-testid="resource-workbench-chat">{pendingPrompt}</div>
  ),
}))
jest.mock("@/hooks/chat/use-resource-workbench-session", () => ({
  useResourceWorkbenchSession: () => ({ id: "artifact-resource-session" }),
}))
jest.mock("@/hooks/context-workbench/use-context-workbench-instance-id", () => ({
  useContextWorkbenchInstanceId: () => "test-workbench",
}))

jest.mock("@/lib/files/workspace-backend", () => ({
  hasWorkspaceFsBackend: () => workspaceAvailable,
}))

jest.mock("./workspace-mode/dock-workspace", () => ({
  DockWorkspace: ({ activeSessionId }: { activeSessionId: string | null }) => (
    <div data-testid="workspace" data-session={activeSessionId ?? ""} />
  ),
}))

jest.mock("./artifact-review-view", () => ({
  ArtifactReviewView: ({ artifact }: { artifact: { id: string } }) => (
    <div data-testid="review-view" data-artifact={artifact.id} />
  ),
}))

jest.mock("@/components/context-workbench/context-comments-panel", () => ({
  ContextCommentsPanel: ({ revision }: { revision: string }) => (
    <div data-testid="comments-panel" data-revision={revision} />
  ),
}))

jest.mock("@/components/browser/browser-preview-pane", () => ({
  BrowserPreviewPane: ({ sessionId }: { sessionId?: string }) => (
    <div data-testid="browser-preview" data-session={sessionId ?? ""} />
  ),
}))

const artifactListProps: Array<{ sessionId?: string }> = []
jest.mock("./artifact-list", () => ({
  ArtifactList: (props: { sessionId?: string }) => {
    artifactListProps.push(props)
    return <div data-testid="list" data-session={props.sessionId ?? ""} />
  },
}))

jest.mock("@/stores/chat", () => ({
  useChatStore: (selector: (s: { activeSessionId: string | null }) => unknown) =>
    selector({ activeSessionId: "sess-1" }),
}))

import { ArtifactContextWorkbench, ArtifactDock } from "./artifact-dock"
import {
  DOCK_MODE_WIDTH_PERCENT,
  useArtifactDockLayoutStore,
} from "@/stores/artifact/artifact-dock-layout-store"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useContextWorkbenchStore } from "@/stores/context-workbench/context-workbench-store"

/** Flip the surface flag off to reach the legacy rollback dock. */
function useLegacyRollbackDock() {
  localStorage.setItem("cognia-context-workbench-surfaces-v1", JSON.stringify({ artifact: false }))
}

function activateArtifact(version = 1) {
  act(() => {
    useArtifactStore.setState({
      activeArtifactId: "artifact-1",
      artifacts: {
        "artifact-1": {
          id: "artifact-1",
          sessionId: "sess-1",
          messageId: "message-1",
          type: "document",
          title: "Document",
          content: "selected text",
          version,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        },
      },
    })
  })
}

beforeEach(() => {
  localStorage.clear()
  workspaceAvailable = true
  artifactListProps.length = 0
  act(() => {
    useArtifactDockLayoutStore.getState().resetLayout()
    useArtifactStore.setState({ activeArtifactId: null, artifacts: {}, pendingReviews: {} })
    useContextWorkbenchStore.setState({ layouts: {}, sessionOverrides: {} })
  })
})

describe("ArtifactDock — converged workbench shell", () => {
  it("renders the artifact workbench with the shared content in desktop mode", () => {
    activateArtifact()
    render(<ArtifactDock />)
    expect(screen.getByTestId("panel-content")).toHaveAttribute("data-mode", "desktop")
  })

  it("keeps the workbench chrome for the no-artifact empty state instead of the legacy dock", () => {
    render(<ArtifactDock />)

    expect(screen.getByTestId("context-workbench-activity-rail")).toBeInTheDocument()
    // The legacy top-tab chrome must not appear — that shape change is the bug.
    expect(screen.queryByTestId("artifact-dock-mode-artifact")).not.toBeInTheDocument()
    // The session surface opens on its artifact history, scoped to the chat.
    expect(screen.getByTestId("list")).toHaveAttribute("data-session", "sess-1")
  })

  it("opens the browser inside the same workbench chrome, scoped to the chat session", () => {
    act(() => useArtifactDockLayoutStore.getState().openBrowser())
    render(<ArtifactDock />)

    expect(screen.getByTestId("context-workbench-activity-rail")).toBeInTheDocument()
    expect(screen.queryByTestId("artifact-dock-mode-browser")).not.toBeInTheDocument()
    expect(screen.getByTestId("browser-preview")).toHaveAttribute("data-session", "sess-1")
    expect(screen.queryByTestId("panel-content")).not.toBeInTheDocument()
  })

  it("still shows the browser in the workbench when an artifact is active", () => {
    activateArtifact()
    act(() => useArtifactDockLayoutStore.getState().openBrowser())
    render(<ArtifactDock />)

    expect(screen.getByTestId("browser-preview")).toBeInTheDocument()
    expect(screen.queryByTestId("panel-content")).not.toBeInTheDocument()
  })

  it("returns to the artifact surface when a session panel leaves browser mode", () => {
    activateArtifact()
    act(() => useArtifactDockLayoutStore.getState().openBrowser())
    render(<ArtifactDock />)
    expect(screen.getByTestId("browser-preview")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "artifacts.dock.workspaceMode" }))

    expect(useArtifactDockLayoutStore.getState().dockMode).toBe("workspace")
    expect(screen.getByTestId("workspace")).toHaveAttribute("data-session", "sess-1")
    expect(screen.queryByTestId("browser-preview")).not.toBeInTheDocument()
  })

  it("opens the session workspace panel scoped to the active chat session", () => {
    act(() => useArtifactDockLayoutStore.getState().setDockMode("workspace"))
    render(<ArtifactDock />)

    expect(screen.getByTestId("workspace")).toHaveAttribute("data-session", "sess-1")
  })

  it("explains the missing workspace backend instead of rendering an empty pane", () => {
    workspaceAvailable = false
    act(() => useArtifactDockLayoutStore.getState().setDockMode("workspace"))

    render(<ArtifactDock />)

    expect(screen.queryByTestId("workspace")).not.toBeInTheDocument()
    expect(screen.getByTestId("context-workbench-activity-rail")).toBeInTheDocument()
  })

  it("collapses the dock from the workbench rail", () => {
    act(() => useArtifactDockLayoutStore.getState().setDockCollapsed(false))
    render(<ArtifactDock />)

    fireEvent.click(screen.getByRole("button", { name: "contextWorkbench.actions.collapse" }))

    expect(useArtifactDockLayoutStore.getState().dockCollapsed).toBe(true)
  })

  it("opens the workspace panel first when the dock mode asks for it", () => {
    activateArtifact()
    act(() => useArtifactDockLayoutStore.getState().setDockMode("workspace"))
    render(<ArtifactDock />)

    // Regression: a fresh scope reconciles onto the first panel, so the panel
    // matching the dock mode must sort first or the dock lands on the wrong one.
    expect(screen.getByTestId("workspace")).toBeInTheDocument()
    expect(screen.queryByTestId("panel-content")).not.toBeInTheDocument()
  })

  it("restores the dock mode when returning to a previously visited panel", () => {
    render(<ArtifactDock />)

    fireEvent.click(screen.getByRole("button", { name: "artifacts.dock.workspaceMode" }))
    expect(useArtifactDockLayoutStore.getState().dockMode).toBe("workspace")

    fireEvent.click(screen.getByRole("button", { name: "artifacts.dock.showHistory" }))
    expect(useArtifactDockLayoutStore.getState().dockMode).toBe("artifact")

    // Re-entering an already-activated panel goes through onRestore, which must
    // re-apply that panel's dock mode rather than leave the previous one.
    fireEvent.click(screen.getByRole("button", { name: "artifacts.dock.workspaceMode" }))
    expect(useArtifactDockLayoutStore.getState().dockMode).toBe("workspace")
  })

  it("drives the outer dock width from the workbench mode buttons", () => {
    activateArtifact()
    render(<ArtifactDock />)

    // The dock is mounted with manageOwnWidth={false}, so without this wiring
    // these two buttons would render but do nothing.
    fireEvent.click(screen.getByRole("button", { name: "contextWorkbench.actions.wide" }))
    expect(useArtifactDockLayoutStore.getState().dockSize).toBe(DOCK_MODE_WIDTH_PERCENT.wide)

    fireEvent.click(screen.getByRole("button", { name: "contextWorkbench.actions.narrow" }))
    expect(useArtifactDockLayoutStore.getState().dockSize).toBe(DOCK_MODE_WIDTH_PERCENT.narrow)
  })

  it("drives the dock width from the session surface too", () => {
    render(<ArtifactDock />)

    fireEvent.click(screen.getByRole("button", { name: "contextWorkbench.actions.wide" }))

    expect(useArtifactDockLayoutStore.getState().dockSize).toBe(DOCK_MODE_WIDTH_PERCENT.wide)
  })

  it("moves Artifact, History, and Workspace into the Context Workbench registry host", () => {
    activateArtifact(3)

    render(<ArtifactDock />)
    expect(screen.getByTestId("context-workbench-activity-rail")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "contextWorkbench.metadata.artifactTitle" }))
    expect(screen.getByRole("tab", { name: "artifacts.dock.workspaceMode" })).toBeInTheDocument()
  })

  it("reveals the proposal review as soon as one arrives", () => {
    activateArtifact()
    render(<ArtifactDock />)
    expect(screen.queryByTestId("review-view")).not.toBeInTheDocument()

    act(() => {
      useArtifactStore.setState({
        pendingReviews: { "artifact-1": { hunks: [] } as never },
      })
    })

    expect(screen.getByTestId("review-view")).toHaveAttribute("data-artifact", "artifact-1")
  })

  it("hosts the workbench in a Sheet on the mobile surface", () => {
    activateArtifact()
    render(
      <ArtifactContextWorkbench
        artifactId="artifact-1"
        mobile={{ open: true, onOpenChange: jest.fn() }}
      />
    )

    expect(screen.getByTestId("context-workbench-mobile-sheet")).toBeInTheDocument()
  })

  it("reaches the artifact history from the review activity group", () => {
    activateArtifact()
    render(<ArtifactDock />)

    // `proposal-review` and `history` share the review activity, so history is a
    // group tab behind the rail button rather than a rail entry of its own.
    fireEvent.click(screen.getByRole("button", { name: "contextWorkbench.proposalReview" }))
    fireEvent.click(screen.getByRole("tab", { name: "artifacts.dock.showHistory" }))

    expect(screen.getByTestId("list")).toHaveAttribute("data-session", "sess-1")
  })

  it("anchors the comments panel to the artifact revision", () => {
    activateArtifact(4)
    render(<ArtifactDock />)

    fireEvent.click(screen.getByRole("button", { name: "contextWorkbench.comments" }))

    expect(screen.getByTestId("comments-panel")).toHaveAttribute("data-revision", "4")
  })

  it("routes an Artifact selection comment into its resource AI panel", () => {
    activateArtifact()
    render(<ArtifactDock />)
    act(() => {
      window.dispatchEvent(
        new CustomEvent("artifact-context-selection", {
          detail: { artifactId: "artifact-1", start: 0, end: 8 },
        })
      )
    })

    fireEvent.click(screen.getByRole("button", { name: "contextWorkbench.resourceChat" }))
    fireEvent.click(screen.getByRole("tab", { name: "contextWorkbench.aiActions" }))
    fireEvent.change(screen.getByRole("textbox", { name: "label" }), {
      target: { value: "Rewrite this selection" },
    })
    fireEvent.click(screen.getByRole("button", { name: "sendToAi" }))

    expect(screen.getByTestId("resource-workbench-chat")).toHaveTextContent(
      "Rewrite this selection"
    )
  })
})

describe("ArtifactDock — legacy rollback surface", () => {
  it("renders the shared content in desktop mode", () => {
    useLegacyRollbackDock()
    render(<ArtifactDock />)
    expect(screen.getByTestId("panel-content")).toHaveAttribute("data-mode", "desktop")
  })

  it("switches between artifact and workspace modes", () => {
    useLegacyRollbackDock()
    render(<ArtifactDock />)
    expect(screen.getByTestId("artifact-dock-mode-artifact")).toHaveAttribute(
      "aria-selected",
      "true"
    )

    fireEvent.click(screen.getByTestId("artifact-dock-mode-workspace"))

    expect(useArtifactDockLayoutStore.getState().dockMode).toBe("workspace")
    expect(screen.getByTestId("workspace")).toHaveAttribute("data-session", "sess-1")
    expect(screen.queryByTestId("panel-content")).not.toBeInTheDocument()
    expect(screen.queryByTestId("artifact-dock-history-toggle")).not.toBeInTheDocument()
  })

  it("opens the browser mode linked to the active chat session", () => {
    useLegacyRollbackDock()
    act(() => useArtifactDockLayoutStore.getState().openBrowser())
    render(<ArtifactDock />)

    expect(screen.getByTestId("artifact-dock-mode-browser")).toHaveAttribute(
      "aria-selected",
      "true"
    )
    expect(screen.getByTestId("browser-preview")).toHaveAttribute("data-session", "sess-1")
    expect(screen.queryByTestId("panel-content")).not.toBeInTheDocument()
    expect(screen.queryByTestId("workspace")).not.toBeInTheDocument()
  })

  it("disables workspace without a backend but preserves a persisted workspace selection", () => {
    useLegacyRollbackDock()
    workspaceAvailable = false
    act(() => useArtifactDockLayoutStore.getState().setDockMode("workspace"))

    render(<ArtifactDock />)

    expect(screen.getByTestId("artifact-dock-mode-workspace")).toBeDisabled()
    expect(screen.getByTestId("artifact-dock-mode-workspace")).toHaveAttribute(
      "aria-selected",
      "true"
    )
    expect(screen.getByTestId("workspace")).toBeInTheDocument()
  })

  it("hides the history rail by default and shows it when toggled", () => {
    useLegacyRollbackDock()
    render(<ArtifactDock />)
    expect(screen.queryByTestId("artifact-dock-history-rail")).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId("artifact-dock-history-toggle"))
    expect(screen.getByTestId("artifact-dock-history-rail")).toBeInTheDocument()
    expect(useArtifactDockLayoutStore.getState().listRailOpen).toBe(true)
  })

  it("scopes the history rail to the active chat session", () => {
    useLegacyRollbackDock()
    act(() => useArtifactDockLayoutStore.getState().setListRailOpen(true))
    render(<ArtifactDock />)
    expect(screen.getByTestId("list")).toHaveAttribute("data-session", "sess-1")
  })

  it("collapses the dock via the collapse button", () => {
    useLegacyRollbackDock()
    act(() => useArtifactDockLayoutStore.getState().setDockCollapsed(false))
    render(<ArtifactDock />)
    fireEvent.click(screen.getByTestId("artifact-dock-collapse"))
    expect(useArtifactDockLayoutStore.getState().dockCollapsed).toBe(true)
  })

  it("keeps the artifact workbench scope in step when switching legacy modes", () => {
    useLegacyRollbackDock()
    activateArtifact()
    render(<ArtifactDock />)

    fireEvent.click(screen.getByTestId("artifact-dock-mode-workspace"))

    expect(
      useContextWorkbenchStore.getState().layouts["test-workbench::artifact:artifact-1"]
        .activePanelId
    ).toBe("workspace")
  })
})
