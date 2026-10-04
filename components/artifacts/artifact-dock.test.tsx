/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent, act, within } from "@testing-library/react"
import { useEffect } from "react"
import {
  TitleBarOutletsProvider,
  TitleBarProjectionScope,
  useTitleBarOutletRef,
} from "@/components/shell/title-bar-outlets"
import { useClientLiveQuery } from "@/hooks/data/use-client-live-query"
import { getSession } from "@/lib/db/sessions"

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
  getContextWorkbenchWindowScope: () => "test",
  useContextWorkbenchInstanceId: (hostKey: string) => `test:${hostKey}`,
}))

jest.mock("@/lib/files/workspace-backend", () => ({
  hasWorkspaceFsBackend: () => workspaceAvailable,
}))

let mockChangedFiles = 0
jest.mock("@/hooks/chat/use-session-resource-changes", () => ({
  useSessionResourceChanges: jest.fn(() => ({ totals: { files: mockChangedFiles } })),
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

// The New Tab page has its own suite. Here it is a launcher with one button per
// tool, so the dock's tests reach a panel the way a user does: `+`, then the
// tool, which opens in the page's place (`SessionNewTabRenderer`).
jest.mock("./dock-new-tab-page", () => ({
  DockNewTabPage: ({ onOpenPanel }: { onOpenPanel: (panelId: string) => void }) => (
    <div data-testid="new-tab-page">
      {["workspace", "project-overview", "browser", "session-sidechat", "artifacts"].map((id) => (
        <button key={id} type="button" onClick={() => onOpenPanel(id)}>
          {`open:${id}`}
        </button>
      ))}
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
  BrowserPreviewPane: ({
    sessionId,
    initialUrl,
    dockPage,
  }: {
    sessionId?: string
    initialUrl?: string
    dockPage?: { owner: string; tabId: string; engine: string }
  }) => {
    useEffect(
      () => () => {
        mockBrowserPreviewCleanup()
      },
      []
    )
    return (
      <div
        data-testid="browser-preview"
        data-session={sessionId ?? ""}
        data-url={initialUrl ?? ""}
        data-owner={dockPage?.owner ?? ""}
        data-engine={dockPage?.engine ?? ""}
      />
    )
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

jest.mock("@/lib/db/sessions", () => ({ getSession: jest.fn(async () => undefined) }))
jest.mock("@/hooks/data/use-client-live-query", () => ({
  useClientLiveQuery: jest.fn(() => mockSessionRecord),
}))
jest.mock("@/components/context-workbench/session-overview-panel", () => {
  const React = jest.requireActual("react")
  const SessionOverviewContext = React.createContext(null)
  return {
    SessionOverviewContext,
    SessionOverviewPanelHost: () => {
      const props = React.useContext(SessionOverviewContext)
      return props ? (
        <div data-testid="session-overview-panel">
          {props.session.model} {props.session.providerOverride} {props.session.workingDir}{" "}
          {props.messageCount} {props.session.id}
          <button onClick={() => props.onNavigate("run-context")}>Open run context</button>
        </div>
      ) : null
    },
  }
})

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
import { useSessionResourceChanges } from "@/hooks/chat/use-session-resource-changes"
import {
  DOCK_MODE_WIDTH_PERCENT,
  useArtifactDockLayoutStore,
} from "@/stores/artifact/artifact-dock-layout-store"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useContextWorkbenchStore } from "@/stores/context-workbench/context-workbench-store"
import { useChatViewportStore } from "@/stores/chat/chat-viewport-store"
import { revealActiveWorkbenchPanel } from "@/lib/context-workbench/active-context"
import { openDockPage } from "@/lib/artifacts/dock-pages"
import { useDockTabsStore } from "@/stores/artifact/dock-tabs-store"

/** Open a conversation tool the way a user does: `+`, then the tool. */
function openFromNewTab(panelId: string) {
  fireEvent.click(screen.getByTestId("dock-tab-new"))
  fireEvent.click(screen.getByRole("button", { name: `open:${panelId}` }))
}

/** Put `ids` on the conversation's strip as open artifact tabs. */
function openArtifactTabs(...ids: string[]) {
  act(() => useArtifactStore.setState({ openArtifactIdsBySession: { "sess-1": ids } }))
}

function addSecondArtifact() {
  act(() => {
    useArtifactStore.setState((state) => ({
      artifacts: {
        ...state.artifacts,
        "artifact-2": { ...state.artifacts["artifact-1"]!, id: "artifact-2", title: "Second" },
      },
    }))
  })
}

/** A remembered page tab, without showing it. */
function seedPageTab(url = "https://a.test/") {
  act(() =>
    useDockTabsStore.getState().addPageTab("sess-1", { id: "pt-1", url, title: "", engine: "auto" })
  )
}

/** Open an address as a page tab of the conversation on screen. */
function openPage(url = "https://a.test/") {
  act(() => {
    openDockPage("sess-1", url)
  })
}

/** The panel a scope is currently showing, per the workbench's own store. */
function activePanelId(scope: "artifact:artifact-1" | "session:sess-1") {
  return useContextWorkbenchStore.getState().layouts[`test:artifact::${scope}`]?.activePanelId
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
    useContextWorkbenchStore.setState({
      layouts: {},
      sessionOverrides: {},
      navigationStyle: "rail",
    })
    useDockTabsStore.setState({ bySession: {} })
  })
})

describe("ArtifactDock — converged workbench shell", () => {
  it("renders the artifact workbench with the shared content in desktop mode", () => {
    activateArtifact()
    render(<ArtifactDock />)
    expect(screen.getByTestId("panel-content")).toHaveAttribute("data-mode", "desktop")
  })

  it("opens an empty dock on the New Tab page, inside the one tab strip", () => {
    render(<ArtifactDock />)

    // The legacy top-tab chrome must not appear — that shape change is the bug.
    expect(screen.queryByTestId("artifact-dock-mode-artifact")).not.toBeInTheDocument()
    // One strip, no activity rail beside an open body, no workbench tablist.
    expect(screen.getByTestId("dock-tab-strip")).toBeInTheDocument()
    expect(screen.queryByTestId("context-workbench-activity-rail")).not.toBeInTheDocument()
    expect(screen.queryByTestId("context-workbench-panel-tabs")).not.toBeInTheDocument()
    // In place of "No artifacts yet" (ADR-0214, D7).
    expect(screen.getByRole("tab", { name: "contextWorkbench.newTab.title" })).toHaveAttribute(
      "aria-selected",
      "true"
    )
    expect(screen.getByTestId("new-tab-page")).toBeInTheDocument()
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
    openPage()
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

  it("shows a page tab inside the same workbench chrome, owned by the chat session", () => {
    openPage("http://localhost:5173/")
    render(<ArtifactDock />)

    expect(screen.getByRole("tab", { name: "localhost:5173" })).toHaveAttribute(
      "aria-selected",
      "true"
    )
    // The browser panel is what renders the tab; it is not a tab of its own.
    expect(screen.queryByRole("tab", { name: "browser.title" })).toBeNull()
    const preview = screen.getByTestId("browser-preview")
    expect(preview).toHaveAttribute("data-session", "sess-1")
    expect(preview).toHaveAttribute("data-owner", "chat:sess-1")
    expect(preview).toHaveAttribute("data-url", "http://localhost:5173/")
    expect(screen.queryByTestId("panel-content")).not.toBeInTheDocument()
  })

  it("shows each page tab in its own pane", () => {
    openPage("https://one.test/")
    openPage("https://two.test/")
    render(<ArtifactDock />)
    expect(screen.getByTestId("browser-preview")).toHaveAttribute("data-url", "https://two.test/")
    fireEvent.click(screen.getByRole("tab", { name: "one.test" }))
    expect(screen.getByTestId("browser-preview")).toHaveAttribute("data-url", "https://one.test/")
  })

  it("opens a browser reveal on what the conversation has open, else the New Tab page", () => {
    act(() => useArtifactDockLayoutStore.getState().openBrowser())
    const { unmount } = render(<ArtifactDock />)
    expect(activePanelId("session:sess-1")).toBe("new-tab")
    unmount()

    openPage("https://kept.test/")
    act(() =>
      useContextWorkbenchStore
        .getState()
        .navigatePanel("test:artifact::session:sess-1", "metadata", "narrow")
    )
    act(() => useArtifactDockLayoutStore.getState().openBrowser())
    render(<ArtifactDock />)
    expect(activePanelId("session:sess-1")).toBe("browser")
    expect(screen.getByTestId("browser-preview")).toHaveAttribute("data-url", "https://kept.test/")
  })

  it("opens a page as its own tab, keeping the artifact one click away", () => {
    activateArtifact()
    openArtifactTabs("artifact-1")
    openPage()
    render(<ArtifactDock />)

    // The artifact is parked, not closed: drawn on the artifact surface the
    // browser would sit under a highlighted artifact tab (ADR-0214, D6).
    expect(screen.getByTestId("browser-preview")).toBeInTheDocument()
    expect(useArtifactStore.getState().activeArtifactIdBySession["sess-1"]).toBeNull()
    expect(activePanelId("session:sess-1")).toBe("browser")
    expect(screen.getByRole("tab", { name: "a.test" })).toHaveAttribute("aria-selected", "true")

    fireEvent.click(screen.getByRole("tab", { name: "Document" }))

    expect(useArtifactStore.getState().activeArtifactIdBySession["sess-1"]).toBe("artifact-1")
    expect(screen.getByTestId("panel-content")).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "a.test" })).toHaveAttribute("aria-selected", "false")
  })

  it("keeps a page tab on the strip across artifact tab switches", () => {
    activateArtifact()
    addSecondArtifact()
    openArtifactTabs("artifact-1", "artifact-2")
    openPage()
    render(<ArtifactDock />)
    expect(screen.getByTestId("browser-preview")).toBeInTheDocument()

    fireEvent.click(screen.getByRole("tab", { name: "Second" }))
    expect(screen.getByTestId("panel-content")).toBeInTheDocument()

    // The page belongs to the conversation, so its tab outlives the switch and
    // brings the browser straight back.
    fireEvent.click(screen.getByRole("tab", { name: "a.test" }))
    expect(screen.getByTestId("browser-preview")).toHaveAttribute("data-session", "sess-1")
  })

  it("opens a tool from the New Tab page in that page's place on the strip", () => {
    activateArtifact()
    openArtifactTabs("artifact-1")
    openPage()
    render(<ArtifactDock />)
    expect(screen.getByTestId("browser-preview")).toBeInTheDocument()

    openFromNewTab("workspace")

    expect(activePanelId("session:sess-1")).toBe("workspace")
    expect(screen.getByTestId("workspace")).toHaveAttribute("data-session", "sess-1")
    const names = screen.getAllByRole("tab").map((tab) => tab.textContent)
    expect(names).toEqual(["artifacts.dock.workspaceMode", "Document", "a.test"])
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
    openArtifactTabs("artifact-1")
    render(<ArtifactDock />)

    openFromNewTab("project-overview")

    expect(screen.getByTestId("project-overview")).toHaveAttribute("data-project", "project-b")
    expect(activePanelId("session:sess-1")).toBe("project-overview")
    expect(screen.getByRole("tab", { name: "Document" })).toBeInTheDocument()
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

    openFromNewTab("workspace")

    expect(screen.queryByTestId("workspace")).not.toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "artifacts.dock.workspaceMode" })).toHaveAttribute(
      "aria-selected",
      "true"
    )
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

  it("switches the artifact's own views from a compact row under the strip", () => {
    activateArtifact()
    render(<ArtifactDock />)

    const views = screen.getByTestId("context-workbench-resource-switcher")
    fireEvent.click(within(views).getByRole("button", { name: "contextWorkbench.proposalReview" }))
    expect(screen.getByTestId("review-view")).toHaveAttribute("data-artifact", "artifact-1")
    // The conversation-wide panels are tabs on the strip, not views of the item.
    expect(within(views).queryByRole("button", { name: "browser.title" })).toBeNull()
    expect(within(views).queryByRole("button", { name: "artifacts.dock.workspaceMode" })).toBeNull()
  })

  it("shows every open artifact on the one strip", () => {
    activateArtifact()
    addSecondArtifact()
    openArtifactTabs("artifact-1", "artifact-2")
    render(<ArtifactDock />)

    expect(screen.getByRole("tab", { name: "Document" })).toHaveAttribute("aria-selected", "true")
    expect(screen.getByRole("tab", { name: "Second" })).toHaveAttribute("aria-selected", "false")
    // No second navigation competing for the header.
    expect(screen.queryByTestId("artifact-tab-strip")).not.toBeInTheDocument()
    expect(screen.queryByTestId("context-workbench-group-overflow")).not.toBeInTheDocument()
  })

  it("collapses the dock from the artifact surface rail too", () => {
    activateArtifact()
    act(() => useArtifactDockLayoutStore.getState().setDockCollapsed(false))
    render(<ArtifactDock />)

    fireEvent.click(screen.getByRole("button", { name: "contextWorkbench.actions.collapse" }))

    expect(useArtifactDockLayoutStore.getState().dockCollapsed).toBe(true)
  })

  it("dismisses the drawer instead of collapsing when hosted on mobile", () => {
    activateArtifact()
    act(() => useArtifactDockLayoutStore.getState().setDockCollapsed(false))
    const onOpenChange = jest.fn()
    render(
      <ArtifactContextWorkbench
        artifactId="artifact-1"
        mobile={{ open: true, onOpenChange, panelMode: "mobile" }}
      />
    )

    // Labelled Close, not Collapse: a bottom drawer has no right edge to fold
    // away, and this is the surface's only button-shaped exit.
    fireEvent.click(screen.getByRole("button", { name: "contextWorkbench.actions.close" }))

    // A drawer has no collapsed rail to shrink to — closing must dismiss it,
    // and must leave the separate desktop dock state alone.
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(useArtifactDockLayoutStore.getState().dockCollapsed).toBe(false)
  })

  it("dismisses the drawer from the session surface too", () => {
    const onOpenChange = jest.fn()
    render(<SessionContextWorkbench mobile={{ open: true, onOpenChange, panelMode: "mobile" }} />)

    fireEvent.click(screen.getByRole("button", { name: "contextWorkbench.actions.close" }))

    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  // The dual of collapsing: something asks the active workbench to bring a
  // panel forward while the container holding it is shut. Opening the panel
  // inside a container nobody can see is a no-op the caller cannot detect, so
  // each of the four host paths has to re-open its own container first.
  describe("re-opening the container for an external reveal", () => {
    it("re-opens the collapsed dock from the session surface", () => {
      // A page to show: with none, a browser reveal lands on the New Tab page.
      seedPageTab()
      act(() => useArtifactDockLayoutStore.getState().setDockCollapsed(true))
      render(<ArtifactDock />)
      act(() => {
        revealActiveWorkbenchPanel("browser")
      })

      expect(useArtifactDockLayoutStore.getState().dockCollapsed).toBe(false)
      expect(activePanelId("session:sess-1")).toBe("browser")
    })

    it("re-opens the collapsed dock from the artifact surface", () => {
      activateArtifact()
      act(() => useArtifactDockLayoutStore.getState().setDockCollapsed(true))
      render(<ArtifactDock />)

      act(() => {
        revealActiveWorkbenchPanel("preview")
      })

      expect(useArtifactDockLayoutStore.getState().dockCollapsed).toBe(false)
      expect(activePanelId("artifact:artifact-1")).toBe("preview")
    })

    // The Sheet hosts ask to be opened rather than uncollapsed, and they only
    // hear the request while they are mounted: a dismissed Sheet renders no
    // content, so there is no workbench registered to reveal into. Reaching a
    // closed Sheet would mean keeping the whole panel body — Monaco, the
    // embedded browser — mounted behind it, which is the cost the Sheet exists
    // to avoid. Within an open one the request still has to land, or the phone
    // Sheet would be the one host that ignores an external reveal.
    it("keeps the Sheet open for an external reveal on the artifact surface", () => {
      activateArtifact()
      const onOpenChange = jest.fn()
      render(
        <ArtifactContextWorkbench
          artifactId="artifact-1"
          mobile={{ open: true, onOpenChange, panelMode: "mobile" }}
        />
      )

      act(() => {
        revealActiveWorkbenchPanel("preview")
      })

      expect(onOpenChange).toHaveBeenCalledWith(true)
      // …and leaves the separate desktop dock state alone, as the collapse
      // direction already does.
      expect(useArtifactDockLayoutStore.getState().dockCollapsed).toBe(true)
    })

    it("keeps the Sheet open for an external reveal on the session surface", () => {
      const onOpenChange = jest.fn()
      render(<SessionContextWorkbench mobile={{ open: true, onOpenChange, panelMode: "mobile" }} />)

      act(() => {
        revealActiveWorkbenchPanel("browser")
      })

      expect(onOpenChange).toHaveBeenCalledWith(true)
    })
  })

  // The session surface carried three panels while the artifact and project
  // surfaces carried eight, leaving the `inspect` and `comments` rail slots
  // empty on the view users see most — every conversation that has not opened
  // an artifact yet.
  describe("session surface — inspect and comments", () => {
    const SESSION_SCOPE = "test:artifact::session:sess-1"

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

      const overview = screen.getByTestId("session-overview-panel")
      expect(overview).toHaveTextContent("claude-opus-5")
      expect(overview).toHaveTextContent("anthropic")
      expect(overview).toHaveTextContent("/repo")
      expect(overview).toHaveTextContent("sess-1")
      fireEvent.click(screen.getByRole("button", { name: "Open run context" }))
      expect(useContextWorkbenchStore.getState().layouts[SESSION_SCOPE].activePanelId).toBe(
        "run-context"
      )
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

    it("counts the conversation's sources and changed files on the collapsed rail", () => {
      mockChangedFiles = 3
      mockSessionMessages = [
        {
          id: "assistant-1",
          role: "assistant",
          parts: [{ type: "source-url", sourceId: "docs", url: "https://example.com" }],
        },
      ]
      // The rail is what a collapsed dock shrinks to; an open one has the strip.
      render(<SessionContextWorkbench railOnly />)

      expect(screen.getByTestId("workbench-activity-inspect")).toHaveTextContent("1")
      // Once, though the source-control panel shares the activity.
      expect(screen.getByTestId("workbench-activity-workspace")).toHaveTextContent("3")
      expect(useSessionResourceChanges).toHaveBeenLastCalledWith("sess-1")
      mockChangedFiles = 0
    })

    it("opens a default sidechat beside the active conversation", () => {
      render(<SessionContextWorkbench />)

      openFromNewTab("session-sidechat")

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

      openFromNewTab("project-overview")

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

  it("keeps the one strip in the dock, whatever the navigation style", () => {
    function HeaderOutlet() {
      const ref = useTitleBarOutletRef("end")
      return <div ref={ref} data-testid="title-outlet" />
    }
    useContextWorkbenchStore.setState({ navigationStyle: "tabs" })
    render(
      <TitleBarOutletsProvider>
        <HeaderOutlet />
        <TitleBarProjectionScope enabled>
          <ArtifactDock />
        </TitleBarProjectionScope>
      </TitleBarOutletsProvider>
    )
    // A strip of tabs needs the dock's full width: never projected.
    const strip = screen.getByTestId("dock-tab-strip")
    expect(screen.getByTestId("context-workbench")).toContainElement(strip)
    expect(screen.getByTestId("title-outlet")).toBeEmptyDOMElement()
    act(() => useContextWorkbenchStore.setState({ navigationStyle: "rail" }))
    expect(screen.getByTestId("title-outlet")).toBeEmptyDOMElement()
    expect(screen.getByTestId("dock-tab-strip")).toBeInTheDocument()
    expect(screen.queryByTestId("context-workbench-activity-rail")).not.toBeInTheDocument()
  })

  it("labels a single open artifact as a tab, without the workbench's own tabs", () => {
    activateArtifact()
    openArtifactTabs("artifact-1")
    act(() => useContextWorkbenchStore.setState({ navigationStyle: "tabs" }))
    render(<ArtifactDock />)
    expect(screen.getByRole("tab", { name: "Document" })).toHaveAttribute("aria-selected", "true")
    expect(screen.queryByTestId("context-workbench-panel-tabs")).not.toBeInTheDocument()
    expect(screen.queryByTestId("context-workbench-activity-rail")).not.toBeInTheDocument()
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
    // per conversation; every open artifact stays reachable beside the panels.
    expect(screen.getByRole("tab", { name: "First" })).toHaveAttribute("aria-selected", "false")
    expect(screen.getByRole("tab", { name: "Second" })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "contextWorkbench.newTab.title" })).toHaveAttribute(
      "aria-selected",
      "true"
    )
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
      useContextWorkbenchStore.getState().layouts["test:artifact::artifact:artifact-1"]?.mode
    ).toBe("focus")

    // ⌘J, the Views menu and the chat-header toggle all write `dockCollapsed`
    // directly and never touch the mode. The overlay used to vanish with the
    // dock's content while the mode persisted, so re-opening came back as a
    // full-screen takeover covering the whole app.
    act(() => useArtifactDockLayoutStore.getState().toggleDock())

    expect(
      useContextWorkbenchStore.getState().layouts["test:artifact::artifact:artifact-1"]?.mode
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
    seedPageTab()
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

    // The workspace is a conversation tab: the artifact is parked so the
    // session surface can take the reveal as its own.
    expect(activePanelId("session:sess-1")).toBe("workspace")
    expect(useArtifactStore.getState().activeArtifactIdBySession["sess-1"]).toBeNull()
    // Consumed on arrival: a lingering intent would re-route the next
    // navigation the user makes by hand.
    expect(useArtifactDockLayoutStore.getState().revealIntent).toBeNull()
  })

  it("follows the active panel with the sizing profile, in one direction only", () => {
    render(<ArtifactDock />)

    openFromNewTab("workspace")
    expect(useArtifactDockLayoutStore.getState().dockProfile).toBe("workspace")

    openFromNewTab("artifacts")
    expect(useArtifactDockLayoutStore.getState().dockProfile).toBe("compact")

    // The predecessor wrote the mode from panel lifecycle hooks AND read it
    // back to order the panels, so re-entering a visited panel could bounce the
    // dock out of the surface asked for. Re-entry must simply work.
    fireEvent.click(screen.getByRole("tab", { name: "artifacts.dock.workspaceMode" }))
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
    openFromNewTab("workspace")

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

    openFromNewTab("workspace")

    // The cap has to come from the *arriving* panel: `dockProfile` is only
    // flipped by an effect after `activePanelId` changes, so reading it here
    // would look up compact.wide (50%) instead of workspace.wide (65%).
    expect(useArtifactDockLayoutStore.getState().dockSize).toBe(
      DOCK_MODE_WIDTH_PERCENT.workspace.wide
    )
  })

  it("carries the width through a reveal published from outside the workbench", () => {
    activateArtifact()
    seedPageTab()
    act(() => useArtifactDockLayoutStore.getState().openBrowser())
    render(<ArtifactDock />)

    // External reveals (the chat header's browser button, the Edit/Write review
    // bridge, save-to-project) reach the workbench through the intent path
    // rather than a click, so they need the same width wiring.
    expect(activePanelId("session:sess-1")).toBe("browser")
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
      useContextWorkbenchStore.getState().setWidth("test:artifact::artifact:artifact-1", 800)
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

  it("opens the conversation's workspace from an artifact, and keeps the artifact's views", () => {
    activateArtifact(3)
    openArtifactTabs("artifact-1")
    render(<ArtifactDock />)

    openFromNewTab("workspace")
    expect(screen.getByTestId("workspace")).toBeInTheDocument()
    expect(activePanelId("session:sess-1")).toBe("workspace")

    fireEvent.click(screen.getByRole("tab", { name: "Document" }))
    fireEvent.click(
      within(screen.getByTestId("context-workbench-resource-switcher")).getByRole("button", {
        name: "contextWorkbench.metadata.artifactTitle",
      })
    )
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

  it("still reaches the proposal review from the artifact's views", () => {
    activateArtifact()
    render(<ArtifactDock />)

    fireEvent.click(
      within(screen.getByTestId("context-workbench-resource-switcher")).getByRole("button", {
        name: "contextWorkbench.proposalReview",
      })
    )

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

    openFromNewTab("session-sidechat")

    expect(screen.getByText("sidechatPlaceholder.title")).toBeInTheDocument()
    expect(screen.getByText("sidechatPlaceholder.description")).toBeInTheDocument()
  })
})

describe("ArtifactDock — the header tab strip", () => {
  it("draws a single open artifact as a tab on the desktop strip", () => {
    // The desktop strip carries panels and artifacts alike, so even one open
    // artifact is a tab there — the old rule of hiding a lone tab belonged to a
    // strip that held artifacts only. The phone Sheet keeps that strip.
    activateArtifact()
    openArtifactTabs("artifact-1")
    render(<ArtifactDock />)
    expect(screen.getByRole("tab", { name: "Document" })).toBeInTheDocument()
    expect(screen.queryByTestId("artifact-tab-strip")).not.toBeInTheDocument()
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

it("does not expose the old live record while the new session query resolves", () => {
  mockSessionRecord = { id: "sess-old", model: "old-model", createdAt: 0, updatedAt: 0 }
  const view = render(<SessionContextWorkbench />)
  act(() =>
    useContextWorkbenchStore
      .getState()
      .navigatePanel("test:artifact::session:sess-1", "metadata", "narrow")
  )
  expect(screen.queryByTestId("session-overview-panel")).not.toBeInTheDocument()
  mockSessionRecord = { id: "sess-1", model: "new-model", createdAt: 0, updatedAt: 0 }
  view.rerender(<SessionContextWorkbench />)
  expect(screen.getByTestId("session-overview-panel")).toHaveTextContent("new-model")
  expect(screen.queryByText("old-model")).not.toBeInTheDocument()
})

it("queries the persisted session by the bound ID without loading the plugin adapter", async () => {
  render(<SessionContextWorkbench />)
  const calls = (useClientLiveQuery as jest.Mock).mock.calls
  const [query, dependencies] = calls.at(-1) as [() => Promise<unknown>, unknown[]]
  expect(dependencies).toEqual(["sess-1"])
  await query()
  expect(getSession).toHaveBeenCalledWith("sess-1")
})
