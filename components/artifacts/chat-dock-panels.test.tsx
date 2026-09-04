/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import type { ComponentType } from "react"
import {
  PROJECT_OVERVIEW_PANEL_ID,
  WORKSPACE_PANEL_ID,
  useArtifactSurfacePanels,
  useSessionSurfacePanels,
  type ArtifactSurfacePanelsInput,
  type SessionSurfacePanelsInput,
} from "./chat-dock-panels"
import type { ContextPanelDefinition, ContextResource } from "@/types/context-workbench"
import type { Artifact } from "@/types/artifact/artifact"
import type { Project, Session } from "@/types/plugin/_compat"

const navigatePanel = jest.fn()
const smartReveal = jest.fn(() => true)
const setDockCollapsed = jest.fn()
let jumpToMessage: ((id: string, a?: unknown, b?: unknown) => boolean) | null = null
const toastError = jest.fn()

jest.mock("sonner", () => ({ toast: { error: (...args: unknown[]) => toastError(...args) } }))

jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
}))

jest.mock("@/stores/context-workbench/context-workbench-store", () => ({
  useContextWorkbenchStore: { getState: () => ({ navigatePanel, smartReveal }) },
}))

let browserRequestUrl: string | null = null
let browserRequestId = 0
jest.mock("@/stores/artifact/artifact-dock-layout-store", () => {
  const store = (selector: (state: unknown) => unknown) =>
    selector({ browserRequestUrl, browserRequestId })
  store.getState = () => ({ setDockCollapsed })
  return { useArtifactDockLayoutStore: store }
})

jest.mock("@/stores/chat/chat-viewport-store", () => ({
  useChatViewportStore: (selector: (state: unknown) => unknown) => selector({ jumpToMessage }),
}))

// Every panel body is someone else's component with its own suite. Stubbing
// them keeps this file about the catalogue: which panels exist, when they
// apply, and what they hand down.
jest.mock("@/components/context-workbench/resource-workbench-chat-panel", () => ({
  ResourceWorkbenchChatPanel: ({
    getResourceContext,
    pendingPrompt,
    onPendingPromptConsumed,
    selectionHeader,
    asideTargetSessionId,
    multiAside,
  }: {
    getResourceContext?: () => string
    pendingPrompt?: string | null
    onPendingPromptConsumed?: () => void
    selectionHeader?: React.ReactNode
    asideTargetSessionId?: string
    multiAside?: boolean
  }) => (
    <div
      data-testid="chat-panel"
      data-context={getResourceContext?.()}
      data-pending={pendingPrompt ?? ""}
      data-aside={asideTargetSessionId ?? ""}
      data-multi={multiAside ? "yes" : "no"}
    >
      {selectionHeader}
      <button type="button" data-testid="consume" onClick={onPendingPromptConsumed}>
        consume
      </button>
    </div>
  ),
}))

jest.mock("@/components/context-workbench/context-comments-panel", () => ({
  ContextCommentsPanel: ({
    resource,
    revision,
    anchor,
  }: {
    resource: { id: string }
    revision: string
    anchor?: { start: number; end: number }
  }) => (
    <div
      data-testid="comments"
      data-resource={resource.id}
      data-revision={revision}
      data-anchor={anchor ? `${anchor.start}-${anchor.end}` : ""}
    />
  ),
}))

jest.mock("@/components/context-workbench/context-metadata-panel", () => ({
  ContextMetadataPanel: ({
    title,
    fields,
    footer,
  }: {
    title: string
    fields: Array<{ label: string; value: unknown }>
    footer?: React.ReactNode
  }) => (
    <div data-testid="metadata" data-title={title}>
      <span data-testid="metadata-values">{fields.map((f) => String(f.value)).join("|")}</span>
      {footer}
    </div>
  ),
}))

jest.mock("@/components/context-workbench/context-capability-unavailable", () => ({
  ContextCapabilityUnavailable: ({ capability }: { capability: string }) => (
    <div data-testid="unavailable" data-capability={capability} />
  ),
}))

jest.mock("@/components/context-workbench/session-sources-panel", () => ({
  SessionSourcesPanel: ({ messages }: { messages: unknown[] }) => (
    <div data-testid="sources" data-count={messages.length} />
  ),
}))

jest.mock("@/components/browser/browser-preview-pane", () => ({
  BrowserPreviewPane: ({
    sessionId,
    requestedUrl,
    requestId,
    onRequestReveal,
  }: {
    sessionId?: string
    requestedUrl?: string
    requestId?: number
    onRequestReveal?: () => boolean
  }) => (
    <div
      data-testid="browser"
      data-session={sessionId ?? "none"}
      data-requested={requestedUrl ?? ""}
      data-request-id={String(requestId ?? "")}
      onClick={() => onRequestReveal?.()}
    />
  ),
}))

jest.mock("@/components/context-workbench/panels/run-context-panel", () => ({
  RunContextPanel: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="run-context" data-session={sessionId} />
  ),
}))

jest.mock("@/components/context-workbench/panels/team-members-panel", () => ({
  TEAM_MEMBERS_PANEL_ID: "team-members",
  TeamMembersPanel: ({
    teamSessionId,
    teamId,
  }: {
    teamSessionId: string | null
    teamId: string | null
  }) => (
    <div
      data-testid="team-members-panel"
      data-session={teamSessionId ?? "none"}
      data-team={teamId ?? "none"}
    />
  ),
}))

jest.mock("./artifact-panel-content", () => ({
  ArtifactPanelContent: ({ panelMode }: { panelMode: string }) => (
    <div data-testid="preview" data-mode={panelMode} />
  ),
}))

jest.mock("./artifact-list", () => ({
  ArtifactList: ({ sessionId }: { sessionId?: string }) => (
    <div data-testid="artifact-list" data-session={sessionId ?? "none"} />
  ),
}))

jest.mock("./artifact-review-view", () => ({
  ArtifactReviewView: ({ panelMode }: { panelMode: string }) => (
    <div data-testid="review" data-mode={panelMode} />
  ),
}))

jest.mock("./workspace-mode/dock-workspace", () => ({
  DockWorkspace: ({
    activeSessionId,
    layout,
  }: {
    activeSessionId: string | null
    layout: string
  }) => (
    <div data-testid="workspace" data-session={activeSessionId ?? "none"} data-layout={layout} />
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
    <button type="button" data-testid="overview" data-project={projectId} onClick={onOpenWorkspace}>
      overview
    </button>
  ),
}))

const artifact: Artifact = {
  id: "a1",
  sessionId: "s1",
  projectId: "p1",
  messageId: "m1",
  type: "code",
  title: "Widget",
  content: "console.log(1)",
  language: "typescript",
  version: 3,
  createdAt: new Date("2024-01-01T00:00:00Z"),
  updatedAt: new Date("2024-01-02T00:00:00Z"),
  metadata: { runtimeHealth: "ready" },
}

const session = {
  id: "s1",
  title: "Chat",
  projectId: "p1",
  model: "claude",
  providerOverride: "anthropic",
  workingDir: "/repo",
  createdAt: 1700000000000,
  updatedAt: 1700000001000,
  messages: [],
} as unknown as Session

const teamSession = { ...session, kind: "team", teamId: "t1" } as unknown as Session

const project = { id: "p1", name: "Repo", roots: [{ path: "/repo" }] } as unknown as Project

const onWidthHint = jest.fn()

function artifactInput(
  overrides: Partial<ArtifactSurfacePanelsInput> = {}
): ArtifactSurfacePanelsInput {
  return {
    artifactId: "a1",
    artifact,
    activeSessionId: "s1",
    sessionProject: project,
    hostLayout: "desktop",
    workspaceLayout: "desktop",
    workspaceAvailable: true,
    pendingReview: null,
    unresolvedCommentCount: 2,
    pendingRunLearningCount: 4,
    textSelection: { kind: "text", start: 4, end: 9 },
    pendingSelectionComment: null,
    onPendingSelectionComment: jest.fn(),
    scopeKey: "scope::artifact:a1",
    onWidthHint,
    ...overrides,
  }
}

function sessionInput(
  overrides: Partial<SessionSurfacePanelsInput> = {}
): SessionSurfacePanelsInput {
  return {
    activeSessionId: "s1",
    session,
    sessionProject: project,
    sessionMessages: [{ id: "m1", role: "user", parts: [] }],
    messageCount: 1,
    workspaceLayout: "desktop",
    workspaceAvailable: true,
    unresolvedCommentCount: 5,
    pendingRunLearningCount: 3,
    scopeKey: "scope::session:s1",
    onWidthHint,
    ...overrides,
  }
}

/**
 * Collect the catalogue a hook returns without mounting the workbench around
 * it, then render one panel's body at a time.
 */
function collect<T>(hook: (input: T) => ContextPanelDefinition[], input: T) {
  let panels: ContextPanelDefinition[] = []
  function Harness() {
    panels = hook(input)
    return null
  }
  render(<Harness />)
  return panels
}

const ARTIFACT_RESOURCE: ContextResource = {
  kind: "artifact",
  artifactId: "a1",
  version: "3",
  capabilities: [],
}
const SESSION_RESOURCE: ContextResource = { kind: "session", sessionId: "s1", capabilities: [] }

function renderPanel(panel: ContextPanelDefinition, resource: ContextResource) {
  const Renderer = panel.renderer as ComponentType<{
    workbenchInstanceId: string
    resource: ContextResource
    active: boolean
  }>
  return render(<Renderer workbenchInstanceId="wb" resource={resource} active />)
}

function panelById(panels: ContextPanelDefinition[], id: string): ContextPanelDefinition {
  const found = panels.find((panel) => panel.id === id)
  if (!found) throw new Error(`no panel ${id}`)
  return found
}

beforeEach(() => {
  jest.clearAllMocks()
  jumpToMessage = null
  browserRequestUrl = null
  browserRequestId = 0
})

describe("useArtifactSurfacePanels", () => {
  it("offers exactly the eleven artifact-surface panels, in a stable order", () => {
    // The rail's group button opens the lowest-ordered panel of an activity, so
    // these numbers are behaviour, not decoration.
    const panels = collect(useArtifactSurfacePanels, artifactInput())
    expect(panels.map((p) => [p.id, p.activity, p.order])).toEqual([
      ["resource-chat", "ai", 25],
      ["comments", "comments", 30],
      ["proposal-review", "review", 20],
      ["preview", "preview-run", 10],
      ["browser", "preview-run", 11],
      ["artifacts", "review", 15],
      ["run-context", "inspect", 37],
      ["metadata", "inspect", 35],
      ["memory", "inspect", 36],
      [PROJECT_OVERVIEW_PANEL_ID, "workspace", 25],
      [WORKSPACE_PANEL_ID, "workspace", 40],
    ])
  })

  it("claims artifact resources and nothing else", () => {
    const panels = collect(useArtifactSurfacePanels, artifactInput())
    expect(panels.every((p) => p.appliesTo(ARTIFACT_RESOURCE))).toBe(true)
    expect(panels.some((p) => p.appliesTo(SESSION_RESOURCE))).toBe(false)
  })

  it("keeps the browser and the workspace mounted across artifact tabs", () => {
    // Both hold session-scoped state — a loaded page, open Monaco buffers — and
    // `scope: "session"` is what stops a tab switch from tearing them down.
    const panels = collect(useArtifactSurfacePanels, artifactInput())
    expect(panelById(panels, "browser").scope).toBe("session")
    expect(panelById(panels, WORKSPACE_PANEL_ID).scope).toBe("session")
    expect(panelById(panels, PROJECT_OVERVIEW_PANEL_ID).scope).toBe("session")
    expect(panelById(panels, "preview").scope).toBeUndefined()
  })

  it("badges unresolved comments and a waiting proposal", () => {
    const withReview = collect(
      useArtifactSurfacePanels,
      artifactInput({ pendingReview: { id: "r1" } as never })
    )
    expect(panelById(withReview, "comments").getBadge?.(ARTIFACT_RESOURCE)).toBe(2)
    expect(panelById(withReview, "proposal-review").getBadge?.(ARTIFACT_RESOURCE)).toBe(1)

    const without = collect(useArtifactSurfacePanels, artifactInput())
    expect(panelById(without, "proposal-review").getBadge?.(ARTIFACT_RESOURCE)).toBe(0)
  })

  it("keeps the session run context available while an artifact is active", () => {
    const panels = collect(useArtifactSurfacePanels, artifactInput())
    const panel = panelById(panels, "run-context")
    expect(panel.scope).toBe("session")
    expect(panel.getBadge?.(ARTIFACT_RESOURCE)).toBe(4)
    renderPanel(panel, ARTIFACT_RESOURCE)
    expect(screen.getByTestId("run-context")).toHaveAttribute("data-session", "s1")
  })

  it("hands the artifact's own content to the resource chat", () => {
    const onPendingSelectionComment = jest.fn()
    const panels = collect(
      useArtifactSurfacePanels,
      artifactInput({ pendingSelectionComment: "explain this", onPendingSelectionComment })
    )
    renderPanel(panelById(panels, "resource-chat"), ARTIFACT_RESOURCE)
    expect(screen.getByTestId("chat-panel")).toHaveAttribute("data-context", "console.log(1)")
    expect(screen.getByTestId("chat-panel")).toHaveAttribute("data-pending", "explain this")
    fireEvent.click(screen.getByTestId("consume"))
    expect(onPendingSelectionComment).toHaveBeenCalledWith(null)
  })

  it("anchors a comment to the live selection", () => {
    const panels = collect(useArtifactSurfacePanels, artifactInput())
    renderPanel(panelById(panels, "comments"), ARTIFACT_RESOURCE)
    expect(screen.getByTestId("comments")).toHaveAttribute("data-anchor", "4-9")
    expect(screen.getByTestId("comments")).toHaveAttribute("data-revision", "3")
  })

  it("drops the anchor when nothing is selected", () => {
    const panels = collect(useArtifactSurfacePanels, artifactInput({ textSelection: undefined }))
    renderPanel(panelById(panels, "comments"), ARTIFACT_RESOURCE)
    expect(screen.getByTestId("comments")).toHaveAttribute("data-anchor", "")
  })

  it("renders metadata, falling back for an artifact that has never run", () => {
    const panels = collect(
      useArtifactSurfacePanels,
      artifactInput({ artifact: { ...artifact, language: undefined, metadata: undefined } })
    )
    renderPanel(panelById(panels, "metadata"), ARTIFACT_RESOURCE)
    const values = screen.getByTestId("metadata-values").textContent ?? ""
    expect(values).toContain("contextWorkbench.metadata.unknown")
    expect(values).toContain("contextWorkbench.metadata.notRun")
  })

  it("renders nothing anywhere once the artifact is gone", () => {
    // The id can outlive its artifact (persist-cap eviction, cleared in another
    // tab). Every body has to tolerate that rather than throw inside the dock.
    const panels = collect(useArtifactSurfacePanels, artifactInput({ artifact: undefined }))
    for (const id of ["comments", "proposal-review", "metadata"]) {
      expect(renderPanel(panelById(panels, id), ARTIFACT_RESOURCE).container).toBeEmptyDOMElement()
    }
    renderPanel(panelById(panels, "resource-chat"), ARTIFACT_RESOURCE)
    expect(screen.getByTestId("chat-panel")).toHaveAttribute("data-context", "")
  })

  it("passes the host's density down rather than re-deriving it", () => {
    const panels = collect(
      useArtifactSurfacePanels,
      artifactInput({ hostLayout: "mobile", workspaceLayout: "mobile" })
    )
    renderPanel(panelById(panels, "preview"), ARTIFACT_RESOURCE)
    expect(screen.getByTestId("preview")).toHaveAttribute("data-mode", "mobile")
    renderPanel(panelById(panels, "proposal-review"), ARTIFACT_RESOURCE)
    expect(screen.getByTestId("review")).toHaveAttribute("data-mode", "mobile")
    renderPanel(panelById(panels, WORKSPACE_PANEL_ID), ARTIFACT_RESOURCE)
    expect(screen.getByTestId("workspace")).toHaveAttribute("data-layout", "mobile")
  })

  it("says so when there is no workspace backend instead of rendering an empty tree", () => {
    const panels = collect(useArtifactSurfacePanels, artifactInput({ workspaceAvailable: false }))
    renderPanel(panelById(panels, WORKSPACE_PANEL_ID), ARTIFACT_RESOURCE)
    expect(screen.getByTestId("unavailable")).toHaveAttribute("data-capability", "workspace")
  })

  it("hides the project overview until the conversation has a project with roots", () => {
    const panels = collect(useArtifactSurfacePanels, artifactInput())
    expect(panelById(panels, PROJECT_OVERVIEW_PANEL_ID).appliesTo(ARTIFACT_RESOURCE)).toBe(true)

    const rootless = collect(
      useArtifactSurfacePanels,
      artifactInput({ sessionProject: { ...project, roots: [] } as unknown as Project })
    )
    expect(panelById(rootless, PROJECT_OVERVIEW_PANEL_ID).appliesTo(ARTIFACT_RESOURCE)).toBe(false)

    const none = collect(useArtifactSurfacePanels, artifactInput({ sessionProject: undefined }))
    expect(
      renderPanel(panelById(none, PROJECT_OVERVIEW_PANEL_ID), ARTIFACT_RESOURCE).container
    ).toBeEmptyDOMElement()
  })

  it("routes the overview's hand-off to the workspace panel and widens for it", () => {
    const panels = collect(useArtifactSurfacePanels, artifactInput())
    renderPanel(panelById(panels, PROJECT_OVERVIEW_PANEL_ID), ARTIFACT_RESOURCE)
    fireEvent.click(screen.getByTestId("overview"))
    expect(navigatePanel).toHaveBeenCalledWith("scope::artifact:a1", WORKSPACE_PANEL_ID, "wide")
    expect(onWidthHint).toHaveBeenCalledWith("wide", WORKSPACE_PANEL_ID)
  })

  it("scopes the browser and the artifact list to the conversation, if there is one", () => {
    const panels = collect(useArtifactSurfacePanels, artifactInput({ activeSessionId: null }))
    renderPanel(panelById(panels, "browser"), ARTIFACT_RESOURCE)
    expect(screen.getByTestId("browser")).toHaveAttribute("data-session", "none")
    renderPanel(panelById(panels, "artifacts"), ARTIFACT_RESOURCE)
    expect(screen.getByTestId("artifact-list")).toHaveAttribute("data-session", "none")
  })
})

describe("opening a link beside the conversation", () => {
  /** Mount the hook for real and keep its browser panel on screen. */
  function mountBrowserPanel() {
    function Harness() {
      const panels = useSessionSurfacePanels(sessionInput())
      const Renderer = panelById(panels, "browser").renderer as ComponentType<{
        workbenchInstanceId: string
        resource: ContextResource
        active: boolean
      }>
      return <Renderer workbenchInstanceId="wb" resource={SESSION_RESOURCE} active />
    }
    return render(<Harness />)
  }

  it("uncollapses the dock when a hidden pane asks to be revealed", () => {
    mountBrowserPanel()
    fireEvent.click(screen.getByTestId("browser"))
    expect(smartReveal).toHaveBeenCalledWith(expect.any(String), "browser", "wide")
    expect(setDockCollapsed).toHaveBeenCalledWith(false)
  })

  it("leaves a pinned workbench pinned, so the caller falls back to the OS browser", () => {
    smartReveal.mockReturnValueOnce(false)
    mountBrowserPanel()
    fireEvent.click(screen.getByTestId("browser"))
    expect(setDockCollapsed).not.toHaveBeenCalled()
  })

  it("hands the pane the address the dock host recorded", () => {
    // The host (`artifact-workspace-dock`) answers for a dock that is collapsed
    // or has never shown this panel, and parks the address on the store. The
    // catalogue's only job is to pass it down to the pane it mounts.
    browserRequestUrl = "https://x.dev/first"
    mountBrowserPanel()
    expect(screen.getByTestId("browser")).toHaveAttribute("data-requested", "https://x.dev/first")
  })

  it("passes the request token down alongside the address", () => {
    // The address alone cannot tell a repeat click apart from a re-render, so
    // the pane needs the store's token to know the link was clicked again.
    browserRequestUrl = "https://x.dev/first"
    browserRequestId = 7
    mountBrowserPanel()
    expect(screen.getByTestId("browser")).toHaveAttribute("data-request-id", "7")
  })
})

describe("the artifact's source-message link", () => {
  function renderMetadataFooter() {
    const panels = collect(useArtifactSurfacePanels, artifactInput())
    return renderPanel(panelById(panels, "metadata"), ARTIFACT_RESOURCE)
  }

  it("is absent when no message list is mounted to jump within", () => {
    renderMetadataFooter()
    expect(screen.queryByTestId("artifact-source-message-link")).toBeNull()
  })

  it("jumps to the message the artifact came out of", () => {
    const jump = jest.fn(() => true)
    jumpToMessage = jump
    renderMetadataFooter()
    fireEvent.click(screen.getByTestId("artifact-source-message-link"))
    expect(jump).toHaveBeenCalledWith("m1", undefined, { align: "center" })
    expect(toastError).not.toHaveBeenCalled()
  })

  it("says the message is unreachable rather than swallowing the click", () => {
    // A mounted list is not a reachable message — it can have been compacted
    // away or belong to another session.
    jumpToMessage = jest.fn(() => false)
    renderMetadataFooter()
    fireEvent.click(screen.getByTestId("artifact-source-message-link"))
    expect(toastError).toHaveBeenCalledWith("chat.jump.notFound")
  })
})

describe("the selection composer inside the resource chat", () => {
  function renderComposer(hasSelection: boolean, onPendingSelectionComment = jest.fn()) {
    const panels = collect(
      useArtifactSurfacePanels,
      artifactInput({
        textSelection: hasSelection ? { kind: "text", start: 1, end: 2 } : undefined,
        onPendingSelectionComment,
      })
    )
    renderPanel(panelById(panels, "resource-chat"), ARTIFACT_RESOURCE)
    return onPendingSelectionComment
  }

  it("asks for a selection first, and refuses to send without one", () => {
    renderComposer(false)
    expect(screen.getByText("contextWorkbench.artifactSelectionComment.selectFirst")).toBeTruthy()
    fireEvent.change(screen.getByRole("textbox", { name: /label/ }), {
      target: { value: "why?" },
    })
    expect(screen.getByRole("button", { name: /sendToAi/ })).toBeDisabled()
  })

  it("sends the trimmed comment and clears the box", () => {
    const onPendingSelectionComment = renderComposer(true)
    expect(
      screen.getByText("contextWorkbench.artifactSelectionComment.selectionReady")
    ).toBeTruthy()
    const box = screen.getByRole("textbox", { name: /label/ })
    fireEvent.change(box, { target: { value: "  explain  " } })
    fireEvent.click(screen.getByRole("button", { name: /sendToAi/ }))
    expect(onPendingSelectionComment).toHaveBeenCalledWith("explain")
    expect(box).toHaveValue("")
  })

  it("refuses whitespace even with a selection", () => {
    const onPendingSelectionComment = renderComposer(true)
    fireEvent.change(screen.getByRole("textbox", { name: /label/ }), { target: { value: "   " } })
    expect(screen.getByRole("button", { name: /sendToAi/ })).toBeDisabled()
    expect(onPendingSelectionComment).not.toHaveBeenCalled()
  })
})

describe("useSessionSurfacePanels", () => {
  it("offers exactly the fourteen session-surface panels, in a stable order", () => {
    const panels = collect(useSessionSurfacePanels, sessionInput())
    expect(panels.map((p) => [p.id, p.activity, p.order])).toEqual([
      ["artifacts", "review", 10],
      ["session-sidechat", "ai", 15],
      ["browser", "preview-run", 20],
      [PROJECT_OVERVIEW_PANEL_ID, "workspace", 25],
      [WORKSPACE_PANEL_ID, "workspace", 30],
      ["source-control", "workspace", 35],
      ["comments", "comments", 40],
      ["run-context", "inspect", 44],
      ["session-sources", "inspect", 45],
      ["metadata", "inspect", 50],
      ["memory", "inspect", 55],
      ["logs", "inspect", 60],
      ["squad-context", "ai", 16],
      ["team-members", "ai", 17],
    ])
  })

  it("claims session resources and nothing else", () => {
    // Team members is the one conditional entry — see the test below.
    const panels = collect(useSessionSurfacePanels, sessionInput({ session: teamSession })).filter(
      (p) => p.id !== "team-members"
    )
    expect(panels.every((p) => p.appliesTo(SESSION_RESOURCE))).toBe(true)
    expect(panels.some((p) => p.appliesTo(ARTIFACT_RESOURCE))).toBe(false)
  })

  it("claims a rail slot for the team roster only inside a team conversation", () => {
    // A direct chat has no roster, so the panel must not take an `ai` slot
    // there — the icon would open a permanently empty surface.
    const direct = panelById(collect(useSessionSurfacePanels, sessionInput()), "team-members")
    expect(direct.appliesTo(SESSION_RESOURCE)).toBe(false)
    expect(direct.appliesTo(ARTIFACT_RESOURCE)).toBe(false)

    const team = panelById(
      collect(useSessionSurfacePanels, sessionInput({ session: teamSession })),
      "team-members"
    )
    expect(team.appliesTo(SESSION_RESOURCE)).toBe(true)
    expect(team.appliesTo(ARTIFACT_RESOURCE)).toBe(false)
    renderPanel(team, SESSION_RESOURCE)
    expect(screen.getByTestId("team-members-panel")).toHaveAttribute("data-team", "t1")
    expect(screen.getByTestId("team-members-panel")).toHaveAttribute("data-session", "s1")
  })

  it("keeps sidechat off an embedded resource workbench", () => {
    // An aside to an aside has no main thread to be an aside *to*.
    const sidechat = panelById(collect(useSessionSurfacePanels, sessionInput()), "session-sidechat")
    expect(
      sidechat.appliesTo({
        kind: "session",
        sessionId: "resource-workbench:a1",
        capabilities: [],
      })
    ).toBe(false)
    expect(sidechat.requiresChatScope).toBe(true)
  })

  it("feeds the sidechat the thread as it stands now, not as it was", () => {
    const panels = collect(useSessionSurfacePanels, sessionInput())
    renderPanel(panelById(panels, "session-sidechat"), SESSION_RESOURCE)
    expect(screen.getByTestId("chat-panel")).toHaveAttribute("data-aside", "s1")
    expect(screen.getByTestId("chat-panel")).toHaveAttribute("data-multi", "yes")
  })

  it("shows a placeholder instead of a sidechat when no conversation is open", () => {
    const panels = collect(
      useSessionSurfacePanels,
      sessionInput({ activeSessionId: null, session: null })
    )
    const sidechat = panelById(panels, "session-sidechat")
    expect(sidechat.requiresChatScope).toBe(false)
    renderPanel(sidechat, SESSION_RESOURCE)
    expect(screen.getByText("contextWorkbench.sidechatPlaceholder.title")).toBeTruthy()
    expect(screen.queryByTestId("chat-panel")).toBeNull()
  })

  it("comments on the conversation itself, keyed to its last update", () => {
    const panels = collect(useSessionSurfacePanels, sessionInput())
    expect(panelById(panels, "comments").getBadge?.(SESSION_RESOURCE)).toBe(5)
    renderPanel(panelById(panels, "comments"), SESSION_RESOURCE)
    expect(screen.getByTestId("comments")).toHaveAttribute("data-resource", "s1")
    expect(screen.getByTestId("comments")).toHaveAttribute("data-revision", "1700000001000")
  })

  it("falls back to revision 0 for a session record that has not loaded", () => {
    const panels = collect(useSessionSurfacePanels, sessionInput({ session: null }))
    renderPanel(panelById(panels, "comments"), SESSION_RESOURCE)
    expect(screen.getByTestId("comments")).toHaveAttribute("data-revision", "0")
  })

  it("renders nothing for comments and metadata with no conversation at all", () => {
    const panels = collect(
      useSessionSurfacePanels,
      sessionInput({ activeSessionId: null, session: null })
    )
    expect(
      renderPanel(panelById(panels, "comments"), SESSION_RESOURCE).container
    ).toBeEmptyDOMElement()
    expect(
      renderPanel(panelById(panels, "metadata"), SESSION_RESOURCE).container
    ).toBeEmptyDOMElement()
  })

  it("reports the session's settings, naming what it does not know", () => {
    const panels = collect(
      useSessionSurfacePanels,
      sessionInput({
        session: {
          ...session,
          model: undefined,
          providerOverride: undefined,
          workingDir: undefined,
        } as unknown as Session,
      })
    )
    renderPanel(panelById(panels, "metadata"), SESSION_RESOURCE)
    const values = screen.getByTestId("metadata-values").textContent ?? ""
    expect(values.match(/contextWorkbench\.metadata\.unknown/g)).toHaveLength(3)
    expect(values).toContain("s1")
  })

  it("lists the sources behind the conversation", () => {
    const panels = collect(useSessionSurfacePanels, sessionInput())
    renderPanel(panelById(panels, "session-sources"), SESSION_RESOURCE)
    expect(screen.getByTestId("sources")).toHaveAttribute("data-count", "1")
  })

  it("opens the session run context and badges pending learning proposals", () => {
    const panels = collect(useSessionSurfacePanels, sessionInput())
    const panel = panelById(panels, "run-context")
    expect(panel.getBadge?.(SESSION_RESOURCE)).toBe(3)
    expect(panel.scope).toBe("session")
    renderPanel(panel, SESSION_RESOURCE)
    expect(screen.getByTestId("run-context")).toHaveAttribute("data-session", "s1")
  })

  it("routes the overview's hand-off to the workspace panel and widens for it", () => {
    const panels = collect(useSessionSurfacePanels, sessionInput())
    renderPanel(panelById(panels, PROJECT_OVERVIEW_PANEL_ID), SESSION_RESOURCE)
    fireEvent.click(screen.getByTestId("overview"))
    expect(navigatePanel).toHaveBeenCalledWith("scope::session:s1", WORKSPACE_PANEL_ID, "wide")
    expect(onWidthHint).toHaveBeenCalledWith("wide", WORKSPACE_PANEL_ID)
  })

  it("hides the project overview until the conversation has a project with roots", () => {
    const rootless = collect(
      useSessionSurfacePanels,
      sessionInput({ sessionProject: { ...project, roots: [] } as unknown as Project })
    )
    expect(panelById(rootless, PROJECT_OVERVIEW_PANEL_ID).appliesTo(SESSION_RESOURCE)).toBe(false)

    const none = collect(useSessionSurfacePanels, sessionInput({ sessionProject: undefined }))
    expect(
      renderPanel(panelById(none, PROJECT_OVERVIEW_PANEL_ID), SESSION_RESOURCE).container
    ).toBeEmptyDOMElement()
  })

  it("says so when there is no workspace backend", () => {
    const panels = collect(useSessionSurfacePanels, sessionInput({ workspaceAvailable: false }))
    renderPanel(panelById(panels, WORKSPACE_PANEL_ID), SESSION_RESOURCE)
    expect(screen.getByTestId("unavailable")).toHaveAttribute("data-capability", "workspace")
  })

  it("passes the host's density to the workspace", () => {
    const panels = collect(useSessionSurfacePanels, sessionInput({ workspaceLayout: "mobile" }))
    renderPanel(panelById(panels, WORKSPACE_PANEL_ID), SESSION_RESOURCE)
    expect(screen.getByTestId("workspace")).toHaveAttribute("data-layout", "mobile")
  })

  it("scopes the browser and the artifact list to the conversation, if there is one", () => {
    const panels = collect(useSessionSurfacePanels, sessionInput({ activeSessionId: null }))
    renderPanel(panelById(panels, "browser"), SESSION_RESOURCE)
    expect(screen.getByTestId("browser")).toHaveAttribute("data-session", "none")
    renderPanel(panelById(panels, "artifacts"), SESSION_RESOURCE)
    expect(screen.getByTestId("artifact-list")).toHaveAttribute("data-session", "none")
  })
})
