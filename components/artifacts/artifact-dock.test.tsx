/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, act } from "@testing-library/react"
import { useEffect } from "react"

let workspaceAvailable = true

jest.mock("sonner", () => ({ toast: { error: jest.fn(), success: jest.fn() } }))

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
    selectionHeader,
    asideTargetSessionId,
    multiAside,
  }: {
    pendingPrompt?: string | null
    getResourceContext?: () => string
    onPendingPromptConsumed?: () => void
    selectionHeader?: React.ReactNode
    asideTargetSessionId?: string
    multiAside?: boolean
  }) => (
    <div
      data-testid="resource-workbench-chat"
      data-context={getResourceContext?.() ?? ""}
      data-aside-target={asideTargetSessionId ?? ""}
      data-multi-aside={multiAside ? "true" : "false"}
    >
      {selectionHeader}
      {pendingPrompt}
      <button type="button" data-testid="consume-prompt" onClick={onPendingPromptConsumed}>
        consume
      </button>
    </div>
  ),
}))
jest.mock("@/components/context-workbench/session-sources-panel", () => ({
  SessionSourcesPanel: ({ messages }: { messages: unknown[] }) => (
    <div data-testid="session-sources-panel" data-count={messages.length} />
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

jest.mock("./workspace-mode/project-overview-panel", () => ({
  ProjectOverviewPanel: ({
    projectId,
    onOpenWorkspace,
  }: {
    projectId: string
    onOpenWorkspace: () => void
  }) => (
    <div data-testid="project-overview" data-project={projectId}>
      <button type="button" onClick={onOpenWorkspace}>
        open-project-workspace
      </button>
    </div>
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

const mockBrowserPreviewCleanup = jest.fn()
jest.mock("@/components/browser/browser-preview-pane", () => ({
  BrowserPreviewPane: ({ sessionId }: { sessionId?: string }) => {
    useEffect(
      () => () => {
        mockBrowserPreviewCleanup()
      },
      []
    )
    return <div data-testid="browser-preview" data-session={sessionId ?? ""} />
  },
}))

const artifactListProps: Array<{ sessionId?: string }> = []
jest.mock("./artifact-list", () => ({
  ArtifactList: (props: { sessionId?: string }) => {
    artifactListProps.push(props)
    return <div data-testid="list" data-session={props.sessionId ?? ""} />
  },
}))

// `sessions` is the per-session message slice map, always initialised in the
// real store — the session surface's metadata panel reads a message count off it.
let mockActiveSessionId: string | null = "sess-1"
let mockSessionMessages: unknown[] = []
jest.mock("@/stores/chat", () => ({
  useChatStore: (
    selector: (s: {
      activeSessionId: string | null
      sessions: Record<string, { messages: unknown[] }>
    }) => unknown
  ) =>
    selector({
      activeSessionId: mockActiveSessionId,
      sessions: { "sess-1": { messages: mockSessionMessages } },
    }),
}))

// The conversation record behind the metadata panel. Absent by default; tests
// that assert on the panel's fields set it.
let mockSessionRecord: unknown = null
jest.mock("@/stores/chat/session-store", () => ({
  useSessionStore: (selector: (s: { sessions: unknown[] }) => unknown) =>
    selector({ sessions: mockSessionRecord ? [mockSessionRecord] : [] }),
}))

let mockProjects: Array<{ id: string; roots: Array<{ id: string; path: string }> }> = []
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: (
    selector: (state: {
      projects: Array<{ id: string; roots: Array<{ id: string; path: string }> }>
    }) => unknown
  ) => selector({ projects: mockProjects }),
}))

import { toast } from "sonner"
import { ArtifactContextWorkbench, ArtifactDock, SessionContextWorkbench } from "./artifact-dock"
import {
  DOCK_MODE_WIDTH_PERCENT,
  useArtifactDockLayoutStore,
} from "@/stores/artifact/artifact-dock-layout-store"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useContextWorkbenchStore } from "@/stores/context-workbench/context-workbench-store"
import { useChatViewportStore } from "@/stores/chat/chat-viewport-store"

/** The panel a scope is currently showing, per the workbench's own store. */
function activePanelId(scope: "artifact:artifact-1" | "session:sess-1") {
  return useContextWorkbenchStore.getState().layouts[`test-workbench::${scope}`]?.activePanelId
}

function activateArtifact(version = 1) {
  act(() => {
    useArtifactStore.setState({
      activeArtifactIdBySession: { "sess-1": "artifact-1" },
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
  jest.clearAllMocks()
  mockActiveSessionId = "sess-1"
  mockSessionMessages = []
  mockProjects = []
  localStorage.clear()
  workspaceAvailable = true
  artifactListProps.length = 0
  mockSessionRecord = null
  act(() => {
    useArtifactDockLayoutStore.getState().resetLayout()
    useArtifactStore.setState({
      activeArtifactIdBySession: {},
      openArtifactIdsBySession: {},
      artifacts: {},
      pendingReviews: {},
    })
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
    // The session surface opens on its artifact browser, scoped to the chat.
    expect(screen.getByTestId("list")).toHaveAttribute("data-session", "sess-1")
  })

  it("passes rail-only through to whichever surface is active", () => {
    // The dock shell shrinks its own column; both surfaces have to be told, or
    // they keep drawing a panel body in a column too narrow for one.
    const { unmount } = render(<ArtifactDock railOnly />)
    expect(screen.getByTestId("context-workbench-activity-rail")).toHaveAttribute(
      "data-rail-only",
      "true"
    )
    unmount()

    activateArtifact()
    render(<ArtifactDock railOnly />)
    expect(screen.getByTestId("context-workbench-activity-rail")).toHaveAttribute(
      "data-rail-only",
      "true"
    )
  })

  it("unmounts the browser renderer when the entire workspace collapses to rail-only", () => {
    act(() => useArtifactDockLayoutStore.getState().openBrowser())
    const { rerender } = render(<ArtifactDock />)
    expect(screen.getByTestId("browser-preview")).toBeInTheDocument()
    mockBrowserPreviewCleanup.mockClear()

    rerender(<ArtifactDock railOnly />)

    expect(screen.queryByTestId("browser-preview")).not.toBeInTheDocument()
    expect(mockBrowserPreviewCleanup).toHaveBeenCalledTimes(1)
  })

  it("shows an attention marker on the rail only while something is unread", () => {
    // With a persistent rail the marker belongs on the rail itself — that is
    // now what the user is looking at — rather than only on the chat header's
    // toggle, which is hidden behind the collapsed column.
    render(<ArtifactDock railOnly />)
    expect(screen.queryByTestId("context-workbench-activity-attention")).toBeNull()

    act(() => useArtifactDockLayoutStore.setState({ unreadArtifact: true }))
    expect(screen.getByTestId("context-workbench-activity-attention")).toBeInTheDocument()
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
    // so the artifact is still what backs the workbench and one click returns
    // to it — with the browser left mounted behind, holding its page.
    expect(screen.getByTestId("browser-preview")).toBeInTheDocument()
    expect(activePanelId("artifact:artifact-1")).toBe("browser")

    // Preview and browser share the `preview-run` activity, so the way back is
    // the group tab rather than the rail button (which now names the browser).
    fireEvent.click(screen.getByRole("tab", { name: "artifacts.dock.artifactMode" }))

    expect(activePanelId("artifact:artifact-1")).toBe("preview")
    expect(screen.getByTestId("panel-content")).toBeInTheDocument()
    expect(screen.getByTestId("browser-preview")).toBeInTheDocument()
  })

  it("keeps the browser mounted across an artifact tab switch", () => {
    activateArtifact()
    act(() => {
      useArtifactStore.setState((state) => ({
        artifacts: {
          ...state.artifacts,
          "artifact-2": { ...state.artifacts["artifact-1"], id: "artifact-2", title: "Second" },
        },
        openArtifactIdsBySession: { "sess-1": ["artifact-1", "artifact-2"] },
      }))
      useArtifactDockLayoutStore.getState().openBrowser()
    })
    const { rerender } = render(<ArtifactDock />)
    expect(screen.getByTestId("browser-preview")).toBeInTheDocument()

    act(() => useArtifactStore.setState({ activeArtifactIdBySession: { "sess-1": "artifact-2" } }))
    rerender(<ArtifactDock />)

    // The browser's content is session-scoped, so it survives the tab switch.
    // Keyed only to the artifact scope, the new tab's empty `activatedPanelIds`
    // unmounted it — releasing a process-wide embedded-webview lease and losing
    // the page, with a blank one on the way back.
    expect(screen.getByTestId("browser-preview")).toBeInTheDocument()
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

  it("keeps the conversation project overview reachable while an artifact is open", () => {
    mockSessionRecord = {
      id: "sess-1",
      projectId: "project-b",
      createdAt: 0,
      updatedAt: 0,
    }
    mockProjects = [
      {
        id: "project-b",
        roots: [{ id: "root-b", path: "/repo/b" }],
      },
    ]
    activateArtifact()
    render(<ArtifactDock />)

    fireEvent.click(screen.getByRole("button", { name: "projectOverview.panelTitle" }))

    expect(screen.getByTestId("project-overview")).toHaveAttribute("data-project", "project-b")
    expect(activePanelId("artifact:artifact-1")).toBe("project-overview")
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

    // The selection composer is folded into the resource-chat panel itself now
    // — as its own panel it shared the `ai` activity at a higher order, so the
    // rail could never open it and two artifact tabs buried it behind ⋯.
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

  it("shows no tab strip for a single artifact, and keeps the group tabs inline", () => {
    activateArtifact()
    render(<ArtifactDock />)

    fireEvent.click(screen.getByRole("button", { name: "artifacts.dock.browseArtifacts" }))

    expect(screen.queryByTestId("artifact-tab-strip")).not.toBeInTheDocument()
    // The header slot must stay free, or the panel's own tabs get displaced
    // into an overflow menu for no reason.
    expect(screen.getByRole("tab", { name: "contextWorkbench.proposalReview" })).toBeInTheDocument()
    expect(screen.queryByTestId("context-workbench-group-overflow")).not.toBeInTheDocument()
  })

  it("hands the header to the artifact tabs once a second artifact is open", () => {
    activateArtifact()
    act(() => {
      useArtifactStore.setState((state) => ({
        artifacts: {
          ...state.artifacts,
          "artifact-2": { ...state.artifacts["artifact-1"], id: "artifact-2", title: "Second" },
        },
        openArtifactIdsBySession: { "sess-1": ["artifact-1", "artifact-2"] },
      }))
    })
    render(<ArtifactDock />)

    fireEvent.click(screen.getByRole("button", { name: "artifacts.dock.browseArtifacts" }))

    // Both cannot share a ~34% wide header, so the panel's group tabs step
    // aside into an overflow menu rather than a third header band appearing.
    expect(screen.getByTestId("artifact-tab-strip")).toBeInTheDocument()
    const overflow = screen.getByTestId("context-workbench-group-overflow")
    expect(overflow).toBeInTheDocument()
    expect(
      screen.queryByRole("tab", { name: "contextWorkbench.proposalReview" })
    ).not.toBeInTheDocument()

    // A bare ⋯ glyph hid both which panel was showing and that there were any
    // others — and in this state it is the only route to the rest of the group.
    expect(overflow).toHaveTextContent("artifacts.dock.browseArtifacts")
    expect(overflow).toHaveTextContent("1")
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

  // The session surface carried three panels while the artifact and project
  // surfaces carried eight, leaving the `inspect` and `comments` rail slots
  // empty on the view users see most — every conversation that has not opened
  // an artifact yet.
  describe("session surface — inspect and comments", () => {
    const SESSION_SCOPE = "test-workbench::session:sess-1"

    it("shows the conversation's own metadata under inspect", () => {
      mockSessionRecord = {
        id: "sess-1",
        title: "Nightly sync",
        model: "claude-opus-5",
        providerOverride: "anthropic",
        workingDir: "/repo",
        createdAt: 0,
        updatedAt: 0,
      }
      render(<SessionContextWorkbench />)
      act(() => {
        useContextWorkbenchStore.getState().navigatePanel(SESSION_SCOPE, "metadata", "narrow")
      })

      expect(screen.getByText("claude-opus-5")).toBeInTheDocument()
      expect(screen.getByText("anthropic")).toBeInTheDocument()
      expect(screen.getByText("/repo")).toBeInTheDocument()
      expect(screen.getByText("sess-1")).toBeInTheDocument()
    })

    it("opens a searchable source explorer for the active conversation", () => {
      mockSessionMessages = [
        {
          id: "assistant-1",
          role: "assistant",
          parts: [{ type: "source-url", sourceId: "docs", url: "https://example.com" }],
        },
      ]
      render(<SessionContextWorkbench />)
      act(() => {
        useContextWorkbenchStore
          .getState()
          .navigatePanel(SESSION_SCOPE, "session-sources", "narrow")
      })

      expect(screen.getByTestId("session-sources-panel")).toHaveAttribute("data-count", "1")
    })

    it("opens a default sidechat beside the active conversation", () => {
      render(<SessionContextWorkbench />)

      fireEvent.click(screen.getByRole("button", { name: "contextWorkbench.sessionSidechat" }))

      expect(screen.getByTestId("resource-workbench-chat")).toHaveAttribute(
        "data-aside-target",
        "sess-1"
      )
      expect(screen.getByTestId("resource-workbench-chat")).toHaveAttribute(
        "data-multi-aside",
        "true"
      )
    })

    it("comments on the conversation itself, not on an artifact", () => {
      mockSessionRecord = {
        id: "sess-1",
        title: "Nightly sync",
        createdAt: 0,
        updatedAt: 7,
      }
      render(<SessionContextWorkbench />)
      act(() => {
        useContextWorkbenchStore.getState().navigatePanel(SESSION_SCOPE, "comments", "narrow")
      })

      // Revision tracks the conversation's own `updatedAt`, so a comment's
      // anchor goes stale when the conversation moves on.
      expect(screen.getByTestId("comments-panel")).toHaveAttribute("data-revision", "7")
    })

    it("renders neither panel with no conversation record to describe", () => {
      render(<SessionContextWorkbench />)
      act(() => {
        useContextWorkbenchStore.getState().navigatePanel(SESSION_SCOPE, "metadata", "narrow")
      })
      // `session` is null here; the panel must not invent fields for it.
      expect(screen.queryByText("claude-opus-5")).not.toBeInTheDocument()
    })

    it("adds a project overview for a conversation with a workspace and opens its editor", () => {
      mockSessionRecord = {
        id: "sess-1",
        projectId: "project-b",
        createdAt: 0,
        updatedAt: 0,
      }
      mockProjects = [
        {
          id: "project-b",
          roots: [{ id: "root-b", path: "/repo/b" }],
        },
      ]
      render(<SessionContextWorkbench />)

      fireEvent.click(screen.getByRole("button", { name: "projectOverview.panelTitle" }))

      expect(screen.getByTestId("project-overview")).toHaveAttribute("data-project", "project-b")
      fireEvent.click(screen.getByRole("button", { name: "open-project-workspace" }))
      expect(activePanelId("session:sess-1")).toBe("workspace")
      expect(screen.getByTestId("workspace")).toHaveAttribute("data-session", "sess-1")
    })

    it("does not add a project overview for a rootless conversation", () => {
      mockSessionRecord = {
        id: "sess-1",
        projectId: "project-empty",
        createdAt: 0,
        updatedAt: 0,
      }
      mockProjects = [{ id: "project-empty", roots: [] }]

      render(<SessionContextWorkbench />)

      expect(
        screen.queryByRole("button", { name: "projectOverview.panelTitle" })
      ).not.toBeInTheDocument()
    })
  })

  it("keeps the artifact tabs on the session surface when no artifact is active", () => {
    act(() =>
      useArtifactStore.setState({
        artifacts: {
          "artifact-1": {
            id: "artifact-1",
            sessionId: "sess-1",
            messageId: "message-1",
            type: "document",
            title: "First",
            content: "x",
            version: 1,
            createdAt: new Date(0),
            updatedAt: new Date(0),
          },
          "artifact-2": {
            id: "artifact-2",
            sessionId: "sess-1",
            messageId: "message-2",
            type: "document",
            title: "Second",
            content: "y",
            version: 1,
            createdAt: new Date(0),
            updatedAt: new Date(0),
          },
        },
        openArtifactIdsBySession: { "sess-1": ["artifact-1", "artifact-2"] },
        activeArtifactIdBySession: {},
      })
    )
    render(<ArtifactDock />)

    // "Tabs open, none active" is an ordinary state now that tabs are bucketed
    // per conversation. The session surface passed no `headerLeading`, so the
    // strip vanished and every other open artifact became unreachable.
    expect(screen.getByTestId("artifact-tab-strip")).toBeInTheDocument()
  })

  it("collapses the dock from the workbench rail", () => {
    act(() => useArtifactDockLayoutStore.getState().setDockCollapsed(false))
    render(<ArtifactDock />)

    fireEvent.click(screen.getByRole("button", { name: "contextWorkbench.actions.collapse" }))

    expect(useArtifactDockLayoutStore.getState().dockCollapsed).toBe(true)
  })

  it("drops focus when the dock is collapsed from outside the workbench", () => {
    activateArtifact()
    act(() => useArtifactDockLayoutStore.getState().setDockCollapsed(false))
    render(<ArtifactDock />)

    fireEvent.click(screen.getByRole("button", { name: "contextWorkbench.actions.focus" }))
    expect(
      useContextWorkbenchStore.getState().layouts["test-workbench::artifact:artifact-1"]?.mode
    ).toBe("focus")

    // ⌘J, the Views menu and the chat-header toggle all write `dockCollapsed`
    // directly and never touch the mode. The overlay used to vanish with the
    // dock's content while the mode persisted, so re-opening came back as a
    // full-screen takeover covering the whole app.
    act(() => useArtifactDockLayoutStore.getState().toggleDock())

    expect(
      useContextWorkbenchStore.getState().layouts["test-workbench::artifact:artifact-1"]?.mode
    ).toBe("narrow")
  })

  it("highlights the width preset the dock is actually at, not the one a panel asked for", () => {
    activateArtifact()
    act(() => {
      useArtifactDockLayoutStore.getState().setDockCollapsed(false)
      useArtifactDockLayoutStore.getState().requestDockSize(DOCK_MODE_WIDTH_PERCENT.compact.wide)
    })
    render(<ArtifactDock />)

    expect(screen.getByRole("button", { name: "contextWorkbench.actions.wide" })).toHaveAttribute(
      "data-variant",
      "secondary"
    )

    // Activating a panel with no `preferredMode` writes `layout.mode = "narrow"`,
    // but the dock's width is a high-water mark that never narrows on its own —
    // so the old highlight claimed "narrow" over a 50%-wide dock.
    fireEvent.click(screen.getByRole("button", { name: "artifacts.dock.artifactMode" }))

    expect(screen.getByRole("button", { name: "contextWorkbench.actions.wide" })).toHaveAttribute(
      "data-variant",
      "secondary"
    )
    expect(screen.getByRole("button", { name: "contextWorkbench.actions.narrow" })).toHaveAttribute(
      "data-variant",
      "ghost"
    )
  })

  it("hands a reveal intent to the session surface when the artifact is gone", () => {
    // The id outlived its artifact, so both workbenches are mounted: the dead
    // artifact scope as the host, the session one as its fallback child. Only
    // the surface actually on screen may consume the intent.
    act(() =>
      useArtifactStore.setState({
        activeArtifactIdBySession: { "sess-1": "artifact-1" },
        artifacts: {},
      })
    )
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

    fireEvent.click(screen.getByRole("button", { name: "artifacts.dock.browseArtifacts" }))
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

  it("widens the dock for a panel that asked for it, at that panel's own cap", () => {
    render(<ArtifactDock />)

    fireEvent.click(screen.getByRole("button", { name: "artifacts.dock.workspaceMode" }))

    // Activating a `preferredMode: "wide"` panel used to light up the header's
    // wide button while leaving the dock at whatever width it already had.
    // The cap has to come from the *arriving* panel too: `dockProfile` is only
    // flipped by an effect after `activePanelId` changes, so reading it here
    // would look up compact.wide (50%) instead of workspace.wide (65%).
    expect(useArtifactDockLayoutStore.getState().dockSize).toBe(
      DOCK_MODE_WIDTH_PERCENT.workspace.wide
    )
  })

  it("carries the width through a reveal published from outside the workbench", () => {
    activateArtifact()
    act(() => useArtifactDockLayoutStore.getState().openBrowser())
    render(<ArtifactDock />)

    // External reveals (the chat header's browser button, the Edit/Write review
    // bridge, save-to-project) reach the workbench through the intent path
    // rather than a click, so they need the same width wiring.
    expect(activePanelId("artifact:artifact-1")).toBe("browser")
    expect(useArtifactDockLayoutStore.getState().dockSize).toBe(
      DOCK_MODE_WIDTH_PERCENT.compact.wide
    )
  })

  it("never narrows the dock on its own, but the header's own button still does", () => {
    activateArtifact()
    render(<ArtifactDock />)
    act(() => useArtifactDockLayoutStore.getState().setDockSize(45))

    // High-water mark: a panel preference may widen, never narrow — otherwise
    // moving between panels would keep yanking back a width the user dragged
    // to, and the dock would feel like it was fighting the pointer.
    fireEvent.click(screen.getByRole("button", { name: "contextWorkbench.comments" }))
    expect(useArtifactDockLayoutStore.getState().dockSize).toBe(45)

    // Naming no panel means an explicit user request, which applies either way.
    fireEvent.click(screen.getByRole("button", { name: "contextWorkbench.actions.narrow" }))
    expect(useArtifactDockLayoutStore.getState().dockSize).toBe(
      DOCK_MODE_WIDTH_PERCENT.compact.narrow
    )
  })

  it("offers a jump back to the message an artifact came out of", () => {
    activateArtifact()
    const jump = jest.fn(() => true)
    act(() => useChatViewportStore.getState().registerJumpToMessage(jump))
    render(<ArtifactDock />)

    fireEvent.click(screen.getByRole("button", { name: "contextWorkbench.metadata.artifactTitle" }))
    fireEvent.click(screen.getByTestId("artifact-source-message-link"))

    // Centred: an artifact's source is a point of interest to look at, not a
    // place to start reading downwards from.
    expect(jump).toHaveBeenCalledWith("message-1", undefined, { align: "center" })
    expect(toast.error).not.toHaveBeenCalled()
  })

  it("says so when the source message is no longer reachable", () => {
    activateArtifact()
    // A list is mounted, but this artifact's message is not in it — compacted
    // away, or owned by a session that is no longer open. Swallowing the click
    // made the button look broken rather than inapplicable.
    act(() => useChatViewportStore.getState().registerJumpToMessage(() => false))
    render(<ArtifactDock />)

    fireEvent.click(screen.getByRole("button", { name: "contextWorkbench.metadata.artifactTitle" }))
    fireEvent.click(screen.getByTestId("artifact-source-message-link"))

    expect(toast.error).toHaveBeenCalledWith("notFound")
  })

  it("hides the source jump when no conversation is mounted to jump within", () => {
    activateArtifact()
    act(() => useChatViewportStore.getState().registerJumpToMessage(null))
    render(<ArtifactDock />)

    fireEvent.click(screen.getByRole("button", { name: "contextWorkbench.metadata.artifactTitle" }))

    // The artifact workspace route and a bare Sheet host have no message list
    // behind them; a dead button there would promise something impossible.
    expect(screen.queryByTestId("artifact-source-message-link")).not.toBeInTheDocument()
  })

  it("never lets the workbench's own width or resize handle reach the chat dock", () => {
    activateArtifact()
    act(() =>
      useContextWorkbenchStore.getState().setWidth("test-workbench::artifact:artifact-1", 800)
    )
    render(<ArtifactDock />)

    // `ContextWorkbenchLayout.width` is intentionally dormant here: the dock
    // mounts with `manageOwnWidth={false}` because its width belongs to the
    // outer ResizablePanel (`dockSize`, a percentage). If the workbench ever
    // starts honouring its own width there would be two writers for one thing,
    // which is exactly the fight the `dockMode` convergence removed.
    const section = screen.getByTestId("context-workbench")
    expect(section.style.width).toBe("")
    expect(screen.queryByRole("separator")).not.toBeInTheDocument()
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

  it("lands the review activity on the artifact browser, not the proposal view", () => {
    activateArtifact()
    render(<ArtifactDock />)

    // The rail targets the lowest-ordered panel in the group. `proposal-review`
    // used to win that race and renders nothing at all without a pending
    // proposal, so the first click on Review handed the user a blank panel
    // while the always-populated artifact browser hid behind the group tabs.
    fireEvent.click(screen.getByRole("button", { name: "artifacts.dock.browseArtifacts" }))

    expect(screen.getByTestId("list")).toHaveAttribute("data-session", "sess-1")
    expect(activePanelId("artifact:artifact-1")).toBe("artifacts")
  })

  it("still reaches the proposal review as a group tab behind the same activity", () => {
    activateArtifact()
    render(<ArtifactDock />)

    fireEvent.click(screen.getByRole("button", { name: "artifacts.dock.browseArtifacts" }))
    fireEvent.click(screen.getByRole("tab", { name: "contextWorkbench.proposalReview" }))

    expect(screen.getByTestId("review-view")).toHaveAttribute("data-artifact", "artifact-1")
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
    // The selection composer is folded into the resource-chat panel itself now
    // — as its own panel it shared the `ai` activity at a higher order, so the
    // rail could never open it and two artifact tabs buried it behind ⋯.
    fireEvent.change(screen.getByRole("textbox", { name: "label" }), {
      target: { value: "Rewrite this selection" },
    })
    fireEvent.click(screen.getByRole("button", { name: "sendToAi" }))

    expect(screen.getByTestId("resource-workbench-chat")).toHaveTextContent(
      "Rewrite this selection"
    )
  })
})

describe("ArtifactDock — with no conversation open", () => {
  it("renders the session surface without a session rather than crashing", () => {
    // Reachable on a cold start, and after closing the last tab. Everything the
    // surface reads off the active session has to tolerate its absence: the
    // workbench scope key, the conversation record, the message count, and the
    // sessionId handed to the embedded panels.
    mockActiveSessionId = null
    expect(() => render(<SessionContextWorkbench />)).not.toThrow()
  })

  it("shows a clear sidechat placeholder instead of an empty panel", () => {
    mockActiveSessionId = null
    render(<SessionContextWorkbench />)

    fireEvent.click(screen.getByRole("button", { name: "contextWorkbench.sessionSidechat" }))

    expect(screen.getByText("sidechatPlaceholder.title")).toBeInTheDocument()
    expect(screen.getByText("sidechatPlaceholder.description")).toBeInTheDocument()
  })
})

describe("ArtifactDock — the header tab strip", () => {
  it("appears once a second artifact is open, and not before", () => {
    // The strip is the only way back to an artifact you left open, so its
    // presence is load-bearing rather than decoration — and it deliberately
    // stays hidden for a single artifact, where it would say nothing.
    activateArtifact()
    act(() => {
      useArtifactStore.setState({ openArtifactIdsBySession: { "sess-1": ["artifact-1"] } })
    })
    const single = render(<ArtifactDock />)
    expect(single.queryByTestId("artifact-tab-strip")).not.toBeInTheDocument()
    single.unmount()

    act(() => {
      useArtifactStore.setState((s) => ({
        artifacts: {
          ...s.artifacts,
          "artifact-2": { ...s.artifacts["artifact-1"]!, id: "artifact-2", title: "Second" },
        },
        openArtifactIdsBySession: { "sess-1": ["artifact-1", "artifact-2"] },
      }))
    })
    render(<ArtifactDock />)
    expect(screen.getByTestId("artifact-tab-strip")).toBeInTheDocument()
  })

  it("carries the strip onto the mobile Sheet host too", () => {
    // Desktop and mobile pass `headerLeading` from separate call sites, so the
    // strip going missing on the phone would not show up in the desktop test.
    activateArtifact()
    act(() => {
      useArtifactStore.setState((s) => ({
        artifacts: {
          ...s.artifacts,
          "artifact-2": { ...s.artifacts["artifact-1"]!, id: "artifact-2", title: "Second" },
        },
        openArtifactIdsBySession: { "sess-1": ["artifact-1", "artifact-2"] },
      }))
    })

    render(
      <ArtifactContextWorkbench
        artifactId="artifact-1"
        mobile={{ open: true, onOpenChange: jest.fn(), panelMode: "mobile" }}
      />
    )
    expect(screen.getByTestId("artifact-tab-strip")).toBeInTheDocument()
  })

  it("carries the strip onto the session surface's mobile host", () => {
    act(() => {
      useArtifactStore.setState({
        artifacts: {
          a1: {
            id: "a1",
            sessionId: "sess-1",
            messageId: "m1",
            type: "document",
            title: "One",
            content: "x",
            version: 1,
            createdAt: new Date(0),
            updatedAt: new Date(0),
          },
          a2: {
            id: "a2",
            sessionId: "sess-1",
            messageId: "m1",
            type: "document",
            title: "Two",
            content: "y",
            version: 1,
            createdAt: new Date(0),
            updatedAt: new Date(0),
          },
        },
        openArtifactIdsBySession: { "sess-1": ["a1", "a2"] },
      })
    })

    render(
      <SessionContextWorkbench
        mobile={{ open: true, onOpenChange: jest.fn(), panelMode: "mobile" }}
      />
    )
    expect(screen.getByTestId("artifact-tab-strip")).toBeInTheDocument()
  })
})
