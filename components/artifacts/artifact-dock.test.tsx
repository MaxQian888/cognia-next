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
  ResourceWorkbenchChatPanel: ({
    pendingPrompt,
    getResourceContext,
    onPendingPromptConsumed,
  }: {
    pendingPrompt?: string | null
    getResourceContext: () => string
    onPendingPromptConsumed: () => void
  }) => (
    <div data-testid="resource-workbench-chat" data-context={getResourceContext()}>
      {pendingPrompt}
      <button type="button" data-testid="consume-prompt" onClick={onPendingPromptConsumed}>
        consume
      </button>
    </div>
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
  ContextCommentsPanel: ({
    revision,
    anchor,
  }: {
    revision: string
    anchor?: { kind: string; start: number; end: number; revision: string }
  }) => (
    <div
      data-testid="comments-panel"
      data-revision={revision}
      data-anchor={anchor ? `${anchor.kind}:${anchor.start}-${anchor.end}@${anchor.revision}` : ""}
    />
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

import { ArtifactContextWorkbench, ArtifactDock, SessionContextWorkbench } from "./artifact-dock"
import {
  DOCK_MODE_WIDTH_PERCENT,
  useArtifactDockLayoutStore,
} from "@/stores/artifact/artifact-dock-layout-store"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useContextWorkbenchStore } from "@/stores/context-workbench/context-workbench-store"

/** The panel a scope is currently showing, per the workbench's own store. */
function activePanelId(scope: "artifact:artifact-1" | "session:sess-1") {
  return useContextWorkbenchStore.getState().layouts[`test-workbench::${scope}`]?.activePanelId
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

  it("opens the browser without dropping the artifact you were looking at", () => {
    activateArtifact()
    act(() => useArtifactDockLayoutStore.getState().openBrowser())
    render(<ArtifactDock />)

    // The browser used to force a swap to the session surface, evicting the
    // artifact scope entirely. It is now a panel on the artifact surface too,
    // so the preview stays mounted (inert) behind it and one click returns.
    expect(screen.getByTestId("browser-preview")).toBeInTheDocument()
    expect(activePanelId("artifact:artifact-1")).toBe("browser")
    expect(screen.getByTestId("panel-content")).toBeInTheDocument()
  })

  it("keeps the artifact scope when moving from the browser to the workspace", () => {
    activateArtifact()
    act(() => useArtifactDockLayoutStore.getState().openBrowser())
    render(<ArtifactDock />)
    expect(screen.getByTestId("browser-preview")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "artifacts.dock.workspaceMode" }))

    expect(activePanelId("artifact:artifact-1")).toBe("workspace")
    expect(screen.getByTestId("workspace")).toHaveAttribute("data-session", "sess-1")
  })

  it("opens the session workspace panel scoped to the active chat session", () => {
    act(() =>
      useArtifactDockLayoutStore.getState().revealWorkspaceReview({
        sessionId: "sess-1",
        rootPath: "/repo",
      })
    )
    render(<ArtifactDock />)

    expect(screen.getByTestId("workspace")).toHaveAttribute("data-session", "sess-1")
  })

  it("explains the missing workspace backend instead of rendering an empty pane", () => {
    workspaceAvailable = false
    render(<ArtifactDock />)

    fireEvent.click(screen.getByRole("button", { name: "artifacts.dock.workspaceMode" }))

    expect(screen.queryByTestId("workspace")).not.toBeInTheDocument()
    expect(screen.getByTestId("context-workbench-activity-rail")).toBeInTheDocument()
  })

  it("feeds the artifact body to its embedded AI panel and clears a consumed prompt", () => {
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
    expect(screen.getByTestId("resource-workbench-chat")).toHaveAttribute(
      "data-context",
      "selected text"
    )

    fireEvent.click(screen.getByRole("tab", { name: "contextWorkbench.aiActions" }))
    fireEvent.change(screen.getByRole("textbox", { name: "label" }), {
      target: { value: "Rewrite this" },
    })
    fireEvent.click(screen.getByRole("button", { name: "sendToAi" }))
    expect(screen.getByTestId("resource-workbench-chat")).toHaveTextContent("Rewrite this")

    // Consuming it must clear the hand-off, or the prompt replays on every
    // later visit to the panel.
    fireEvent.click(screen.getByTestId("consume-prompt"))
    expect(screen.getByTestId("resource-workbench-chat")).not.toHaveTextContent("Rewrite this")
  })

  it("collapses the dock from the artifact surface rail too", () => {
    activateArtifact()
    act(() => useArtifactDockLayoutStore.getState().setDockCollapsed(false))
    render(<ArtifactDock />)

    fireEvent.click(screen.getByRole("button", { name: "contextWorkbench.actions.collapse" }))

    expect(useArtifactDockLayoutStore.getState().dockCollapsed).toBe(true)
  })

  it("dismisses the Sheet instead of collapsing when hosted on mobile", () => {
    activateArtifact()
    act(() => useArtifactDockLayoutStore.getState().setDockCollapsed(false))
    const onOpenChange = jest.fn()
    render(
      <ArtifactContextWorkbench
        artifactId="artifact-1"
        mobile={{ open: true, onOpenChange, panelMode: "mobile" }}
      />
    )

    fireEvent.click(screen.getByRole("button", { name: "contextWorkbench.actions.collapse" }))

    // A Sheet has no collapsed rail to shrink to — collapsing must close it,
    // and must leave the separate desktop dock state alone.
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(useArtifactDockLayoutStore.getState().dockCollapsed).toBe(false)
  })

  it("dismisses the Sheet from the session surface too", () => {
    const onOpenChange = jest.fn()
    render(<SessionContextWorkbench mobile={{ open: true, onOpenChange, panelMode: "mobile" }} />)

    fireEvent.click(screen.getByRole("button", { name: "contextWorkbench.actions.collapse" }))

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("collapses the dock from the workbench rail", () => {
    act(() => useArtifactDockLayoutStore.getState().setDockCollapsed(false))
    render(<ArtifactDock />)

    fireEvent.click(screen.getByRole("button", { name: "contextWorkbench.actions.collapse" }))

    expect(useArtifactDockLayoutStore.getState().dockCollapsed).toBe(true)
  })

  it("hands a reveal intent to the session surface when the artifact is gone", () => {
    // The id outlived its artifact, so both workbenches are mounted: the dead
    // artifact scope as the host, the session one as its fallback child. Only
    // the surface actually on screen may consume the intent.
    act(() => useArtifactStore.setState({ activeArtifactId: "artifact-1", artifacts: {} }))
    act(() => useArtifactDockLayoutStore.getState().openBrowser())
    render(<ArtifactDock />)

    expect(activePanelId("session:sess-1")).toBe("browser")
    expect(activePanelId("artifact:artifact-1")).toBeUndefined()
    expect(screen.getByTestId("browser-preview")).toBeInTheDocument()
  })

  it("routes a one-shot reveal intent to the panel that owns it, then clears it", () => {
    activateArtifact()
    act(() =>
      useArtifactDockLayoutStore.getState().requestReveal({ panelId: "workspace", mode: "wide" })
    )
    render(<ArtifactDock />)

    expect(activePanelId("artifact:artifact-1")).toBe("workspace")
    // Consumed on arrival: a lingering intent would re-route the next
    // navigation the user makes by hand.
    expect(useArtifactDockLayoutStore.getState().revealIntent).toBeNull()
  })

  it("follows the active panel with the sizing profile, in one direction only", () => {
    render(<ArtifactDock />)

    fireEvent.click(screen.getByRole("button", { name: "artifacts.dock.workspaceMode" }))
    expect(useArtifactDockLayoutStore.getState().dockProfile).toBe("workspace")

    fireEvent.click(screen.getByRole("button", { name: "artifacts.dock.showHistory" }))
    expect(useArtifactDockLayoutStore.getState().dockProfile).toBe("compact")

    // The predecessor wrote the mode from panel lifecycle hooks AND read it
    // back to order the panels, so re-entering a visited panel could bounce the
    // dock out of the surface asked for. Re-entry must simply work.
    fireEvent.click(screen.getByRole("button", { name: "artifacts.dock.workspaceMode" }))
    expect(useArtifactDockLayoutStore.getState().dockProfile).toBe("workspace")
    expect(activePanelId("session:sess-1")).toBe("workspace")
  })

  it("drives the outer dock width from the workbench mode buttons", () => {
    activateArtifact()
    render(<ArtifactDock />)

    // The dock is mounted with manageOwnWidth={false}, so without this wiring
    // these two buttons would render but do nothing.
    fireEvent.click(screen.getByRole("button", { name: "contextWorkbench.actions.wide" }))
    expect(useArtifactDockLayoutStore.getState().dockSize).toBe(
      DOCK_MODE_WIDTH_PERCENT.compact.wide
    )

    fireEvent.click(screen.getByRole("button", { name: "contextWorkbench.actions.narrow" }))
    expect(useArtifactDockLayoutStore.getState().dockSize).toBe(
      DOCK_MODE_WIDTH_PERCENT.compact.narrow
    )
  })

  it("lets wide reach the workspace cap once the workspace panel is showing", () => {
    render(<ArtifactDock />)
    fireEvent.click(screen.getByRole("button", { name: "artifacts.dock.workspaceMode" }))

    fireEvent.click(screen.getByRole("button", { name: "contextWorkbench.actions.wide" }))

    // A single shared preset table capped this at the artifact bound (50%)
    // even though the workspace panel allows 65%.
    expect(useArtifactDockLayoutStore.getState().dockSize).toBe(
      DOCK_MODE_WIDTH_PERCENT.workspace.wide
    )
  })

  it("drives the dock width from the session surface too", () => {
    render(<ArtifactDock />)

    fireEvent.click(screen.getByRole("button", { name: "contextWorkbench.actions.wide" }))

    expect(useArtifactDockLayoutStore.getState().dockSize).toBe(
      DOCK_MODE_WIDTH_PERCENT.compact.wide
    )
  })

  it("gives the workspace its own rail entry rather than burying it under metadata", () => {
    activateArtifact(3)
    render(<ArtifactDock />)

    // `workspace` used to share the inspect activity with `metadata`, which
    // sorts first — so the project workspace sat behind an info icon plus a
    // group tab. It is a one-click rail entry now, and metadata keeps its own.
    fireEvent.click(screen.getByRole("button", { name: "artifacts.dock.workspaceMode" }))
    expect(screen.getByTestId("workspace")).toBeInTheDocument()
    expect(activePanelId("artifact:artifact-1")).toBe("workspace")

    fireEvent.click(screen.getByRole("button", { name: "contextWorkbench.metadata.artifactTitle" }))
    expect(activePanelId("artifact:artifact-1")).toBe("metadata")
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
        mobile={{ open: true, onOpenChange: jest.fn(), panelMode: "mobile" }}
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

    // No selection: a whole-resource comment, carrying no range.
    expect(screen.getByTestId("comments-panel")).toHaveAttribute("data-revision", "4")
    expect(screen.getByTestId("comments-panel")).toHaveAttribute("data-anchor", "")
  })

  it("pins a comment made on a selection to that text range and revision", () => {
    activateArtifact(4)
    render(<ArtifactDock />)
    act(() => {
      window.dispatchEvent(
        new CustomEvent("artifact-context-selection", {
          detail: { artifactId: "artifact-1", start: 2, end: 9 },
        })
      )
    })

    fireEvent.click(screen.getByRole("button", { name: "contextWorkbench.comments" }))

    // The revision travels with the range: without it a later edit would leave
    // the comment silently pointing at different text.
    expect(screen.getByTestId("comments-panel")).toHaveAttribute("data-anchor", "text-range:2-9@4")
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
