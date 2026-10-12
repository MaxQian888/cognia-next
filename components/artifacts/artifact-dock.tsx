"use client"

/**
 * ArtifactDock — the docked (non-modal) artifacts surface that lives in the
 * right rail of the chat workspace on desktop.
 *
 * There is exactly ONE shell: the shared Context Workbench (ADR-0083). Which
 * resource backs it is the only branch — an artifact when one is active, the
 * chat session otherwise — and every surface the dock ever showed (preview,
 * history, embedded browser, workspace, comments, review, metadata) is a panel
 * inside it. Panel selection lives solely in `contextWorkbenchStore`; the
 * layout store contributes sizing and one-shot reveal intents, never routing.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  TitleBarProjectionScope,
  useTitleBarProjectionScope,
} from "@/components/shell/title-bar-outlets"
import { hasWorkspaceFsBackend } from "@/lib/files/workspace-backend"
import { isRunnableArtifactType } from "@/lib/artifacts/constants"
import { useChatStore } from "@/stores/chat"
import { useSessionStore } from "@/stores/chat/session-store"
import {
  DOCK_MODE_WIDTH_PERCENT,
  WORKSPACE_SURFACE_PANEL_IDS,
  useArtifactDockLayoutStore,
} from "@/stores/artifact/artifact-dock-layout-store"
import type { ArtifactPanelMode } from "./artifact-panel-content"
import { ArtifactTabStrip, useOpenArtifactTabs } from "./artifact-tab-strip"
import { DockTabStrip } from "./dock-tab-strip"
import { DOCK_SESSION_PANEL_META } from "./dock-panel-meta"
import { useArtifactSurfacePanels, useSessionSurfacePanels } from "./chat-dock-panels"
import {
  ContextWorkbench,
  ContextWorkbenchMobileDrawer,
} from "@/components/context-workbench/context-workbench"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useActiveArtifactId } from "@/hooks/artifacts/use-session-artifacts"
import {
  ARTIFACT_DOCK_WORKBENCH_HOST_KEY,
  sessionWorkbenchScopeKey,
} from "@/lib/artifacts/session-workbench-scope-key"
import { useContextWorkbenchStore } from "@/stores/context-workbench/context-workbench-store"
import type { ContextPanelMode, ContextResource } from "@/types/context-workbench"
import { useContextWorkbenchInstanceId } from "@/hooks/context-workbench/use-context-workbench-instance-id"
import { resolveContextCapabilities } from "@/lib/context-workbench/capabilities"
import { useContextCommentBadge } from "@/hooks/context-workbench/use-context-comment-badge"
import { useProjectStore } from "@/stores/project/project-store"
import type { UIMessage } from "ai"
import { useLiveQuery } from "dexie-react-hooks"
import { useClientLiveQuery } from "@/hooks/data/use-client-live-query"
import {
  SessionOverviewContext,
  type SessionOverviewContextValue,
} from "@/components/context-workbench/session-overview-panel"
import { getSession } from "@/lib/db/sessions"
import { countPendingSessionRunLearningProposals } from "@/lib/db/run-retrospectives"
import { useSessionResourceChanges } from "@/hooks/chat/use-session-resource-changes"
import { collectSessionSources } from "@/lib/chat/session-sources"

/**
 * The activity that carries the dock's unread dot, per surface.
 *
 * `notifyNewArtifact` names no panel — it only knows something arrived — so the
 * marker goes wherever the rail would actually land, which is the surface's
 * lowest-ordered panel. Those differ: the artifact surface opens on `preview`
 * (`preview-run`), while the session surface's first panel is the artifact list
 * (`review`). One shared constant put the dot on the session surface's *browser*
 * icon, pointing at a panel that has nothing to do with the new artifact.
 */
const ARTIFACT_ATTENTION_ACTIVITY = "preview-run"
const SESSION_ATTENTION_ACTIVITY = "review"

/**
 * Memoised because the host re-renders on layout writes (a drag, the chat row's
 * measurements) that have nothing new to tell the dock — its props are two
 * booleans.
 *
 * Two surfaces back the one workbench shell: an artifact's, while an artifact
 * tab is in front, and the conversation's own (the Workspace, the browser, the
 * side chat…) otherwise. They are different components, so swapping one for
 * the other used to unmount the session surface whenever an artifact tab came
 * forward — every artifact → Workspace switch rebuilt the project editor from
 * nothing: tree listing, git loads, file watcher, Monaco models. Once it has
 * been shown, the session surface now stays mounted behind the artifact one,
 * hidden and `concealed` (effects live, the embedded browser parked), so
 * coming back to it is a reveal.
 */
export const ArtifactDock = memo(function ArtifactDock({
  railOnly,
  concealed = false,
}: {
  railOnly?: boolean
  /** The dock is collapsed but kept mounted (`ContextWorkbench`'s `concealed`). */
  concealed?: boolean
}) {
  const activeArtifactId = useActiveArtifactId()
  // An id can outlive its artifact (evicted by the persist cap, or cleared in
  // another tab); the session surface is the dock's shell then.
  const artifactInFront = useArtifactStore((state) =>
    Boolean(activeArtifactId && state.artifacts[activeArtifactId])
  )
  const [sessionSurfaceBuilt, setSessionSurfaceBuilt] = useState(!artifactInFront)
  if (!artifactInFront && !sessionSurfaceBuilt) setSessionSurfaceBuilt(true)
  const projection = useTitleBarProjectionScope()
  return (
    <>
      {sessionSurfaceBuilt ? (
        <div
          data-testid="dock-session-surface"
          className="h-full"
          hidden={artifactInFront}
          inert={artifactInFront || undefined}
        >
          {/* Behind an artifact, its header must not project into the title
              bar beside the artifact surface's. */}
          <TitleBarProjectionScope enabled={projection && !artifactInFront}>
            <SessionContextWorkbench
              railOnly={railOnly}
              concealed={concealed || artifactInFront}
              inBackground={artifactInFront}
            />
          </TitleBarProjectionScope>
        </div>
      ) : null}
      {artifactInFront && activeArtifactId ? (
        <ArtifactContextWorkbench
          artifactId={activeArtifactId}
          railOnly={railOnly}
          concealed={concealed}
        />
      ) : null}
    </>
  )
})

/**
 * The dock is mounted with `manageOwnWidth={false}` — its width belongs to the
 * outer ResizablePanel — so the workbench header's narrow/wide buttons have to
 * resize the dock instead of the workbench, or they do nothing at all.
 *
 * Two callers, two contracts (see `onModeWidthHint`): the header buttons name
 * no panel and are applied; a panel activation names its panel and is
 * ignored. Switching tabs used to widen the dock to the arriving panel's
 * preset (and, on the way back, clamp it to a narrower profile's cap), so the
 * divider moved and the conversation reflowed on every tab switch. The dock
 * keeps one width for every tab — sized for the Workspace — and only the user
 * changes it: the narrow/wide buttons, the divider, a double-click on it.
 */
function useDockWidthHint() {
  const requestDockSize = useArtifactDockLayoutStore((state) => state.requestDockSize)
  return useCallback(
    (mode: ContextPanelMode, panelId?: string) => {
      // Focus is a full-screen takeover; it owns no dock width.
      if (mode === "focus" || panelId) return
      requestDockSize(DOCK_MODE_WIDTH_PERCENT[mode])
    },
    [requestDockSize]
  )
}

/** Midpoint between the presets: every width above it reads as "wide". */
const WIDE_THRESHOLD_PERCENT = (DOCK_MODE_WIDTH_PERCENT.narrow + DOCK_MODE_WIDTH_PERCENT.wide) / 2

/**
 * Which width preset the dock is *actually* sitting at, for the workbench
 * header's narrow/wide highlight.
 *
 * The dock's width lives in `dockSize`, not in `layout.mode`: mounted with
 * `manageOwnWidth={false}`, the workbench never applies its own width, so that
 * field only ever coloured two buttons. Deriving it from the width means the
 * highlight cannot lie, and dragging the divider updates it for free.
 *
 * Selected as the derived mode, not as `dockSize`: a drag writes `dockSize` on
 * every pointer tick, and subscribing to the number re-rendered the whole
 * workbench — every panel prop rebuilt — sixty times a second while the
 * divider moved, for a value that changes once per drag at most.
 */
function useResolvedDockMode(): ContextPanelMode {
  return useArtifactDockLayoutStore((state) =>
    state.dockSize >= WIDE_THRESHOLD_PERCENT ? "wide" : "narrow"
  )
}

/**
 * Tell the layout store whether the Workspace surface is showing, and consume
 * any one-shot reveal intent this surface can satisfy.
 *
 * This is the ONLY writer of `workspaceSurfaceActive` besides the workspace
 * reveals that seed it, and it is strictly one-directional: panel → flag. The
 * flag carries no width — leaving the Workspace only drops the reveal that was
 * routing there.
 */
function useDockPanelSync(
  scopeKey: string,
  panelIds: string[],
  activePanelId: string | null | undefined,
  onWidthHint: (mode: ContextPanelMode, panelId?: string) => void,
  /**
   * False for a surface kept mounted behind the one in front. It must neither
   * report its panel as the one showing nor take a reveal meant for whatever
   * is on screen.
   */
  enabled = true
) {
  const setWorkspaceSurfaceActive = useArtifactDockLayoutStore(
    (state) => state.setWorkspaceSurfaceActive
  )
  const revealIntent = useArtifactDockLayoutStore((state) => state.revealIntent)
  const consumeRevealIntent = useArtifactDockLayoutStore((state) => state.consumeRevealIntent)
  const dockCollapsed = useArtifactDockLayoutStore((state) => state.dockCollapsed)
  const navigatePanel = useContextWorkbenchStore((state) => state.navigatePanel)
  const setMode = useContextWorkbenchStore((state) => state.setMode)
  const isFocus = useContextWorkbenchStore((state) => state.layouts[scopeKey]?.mode === "focus")

  useEffect(() => {
    if (!enabled || !activePanelId) return
    setWorkspaceSurfaceActive(WORKSPACE_SURFACE_PANEL_IDS.has(activePanelId))
  }, [activePanelId, enabled, setWorkspaceSurfaceActive])

  // Focus is a full-screen takeover that outlives the dock it was opened from.
  // The workbench's own collapse button drops it on the way out, but the three
  // routes users actually reach for — ⌘J, the desktop Views menu, the chat
  // header toggle — write `dockCollapsed` directly and never touch the mode. The
  // overlay then vanished with the dock's content 240ms later while the mode
  // persisted, so re-opening came back `fixed inset-0 z-50` over the whole app.
  // This seam is the only one that can see both facts, so the rule lives here.
  useEffect(() => {
    if (!enabled || !dockCollapsed || !isFocus) return
    setMode(scopeKey, "narrow")
  }, [dockCollapsed, enabled, isFocus, scopeKey, setMode])

  const owns = enabled && revealIntent ? panelIds.includes(revealIntent.panelId) : false
  useEffect(() => {
    if (!revealIntent || !owns) return
    navigatePanel(scopeKey, revealIntent.panelId, revealIntent.mode)
    // An external reveal carries a mode too, and it reaches the workbench
    // through this path rather than `handleActivate` — so without the hint the
    // chat header's browser button, the Edit/Write review bridge and
    // save-to-project all asked for "wide" and got whatever width the dock
    // happened to be at.
    onWidthHint(revealIntent.mode, revealIntent.panelId)
    consumeRevealIntent(revealIntent.panelId)
  }, [consumeRevealIntent, navigatePanel, onWidthHint, owns, revealIntent, scopeKey])
}

/** Stable identity so the sync effects don't re-run on every render. */
const EMPTY_PANEL_IDS: string[] = []
const SOURCE_COUNT_LABELS = { document: "", file: "" }

/**
 * Source counts per message list. A store selector re-runs on every chat-store
 * write — other sessions streaming included — so the walk is cached on the
 * list's identity and only redone when this conversation's messages change.
 */
const sourceCountByMessages = new WeakMap<readonly UIMessage[], number>()

function countSessionSources(messages: readonly UIMessage[] | undefined): number {
  if (!messages || messages.length === 0) return 0
  const cached = sourceCountByMessages.get(messages)
  if (cached !== undefined) return cached
  const count = collectSessionSources(messages as UIMessage[], SOURCE_COUNT_LABELS).length
  sourceCountByMessages.set(messages, count)
  return count
}

/**
 * Set by the Sheet host (`<ArtifactPanel />`). `panelMode` is the host's own
 * density decision — tablet still wants Monaco, only a phone drops to the light
 * editor — so the panels must not re-derive it from the viewport.
 */
export interface SheetHost {
  open: boolean
  onOpenChange: (open: boolean) => void
  panelMode: ArtifactPanelMode
}

export function ArtifactContextWorkbench({
  artifactId,
  mobile,
  railOnly,
  concealed,
}: {
  artifactId: string
  mobile?: SheetHost
  railOnly?: boolean
  concealed?: boolean
}) {
  const workbenchInstanceId = useContextWorkbenchInstanceId(ARTIFACT_DOCK_WORKBENCH_HOST_KEY)
  // The phone Sheet keeps the artifact strip; the desktop dock draws its one
  // strip of panels and artifacts (`DockTabStrip`) in its own header row — a
  // strip of tabs needs the dock's full width, so it is never projected into
  // the title bar.
  const showSingleArtifactTab = useContextWorkbenchStore(
    (state) => state.navigationStyle !== "rail"
  )
  const artifact = useArtifactStore((state) => state.artifacts[artifactId])
  const unresolvedCommentCount = useContextCommentBadge("artifact", artifactId)
  const pendingReview = useArtifactStore((state) => state.pendingReviews[artifactId] ?? null)
  const hadPendingReview = useRef(false)
  const activeSessionId = useChatStore((state) => state.activeSessionId)
  const sessionProjectId = useSessionStore((state) =>
    activeSessionId
      ? state.sessions.find((session) => session.id === activeSessionId)?.projectId
      : undefined
  )
  const sessionProject = useProjectStore((state) =>
    sessionProjectId ? state.projects.find((project) => project.id === sessionProjectId) : undefined
  )
  const setDockCollapsed = useArtifactDockLayoutStore((state) => state.setDockCollapsed)
  const mobileSnapPoint = useArtifactDockLayoutStore((state) => state.mobileSnapPoint)
  const setMobileSnapPoint = useArtifactDockLayoutStore((state) => state.setMobileSnapPoint)
  // Something arrived while the dock was dismissed. With a persistent rail the
  // marker belongs on the rail itself — that is now the thing the user is
  // looking at — rather than only on the title bar's dock toggle.
  const unreadArtifact = useArtifactDockLayoutStore((state) => state.unreadArtifact)
  const smartReveal = useContextWorkbenchStore((state) => state.smartReveal)
  const scopeKey = `${workbenchInstanceId}::artifact:${artifactId}`
  // The session surface's own scope key. Session-scoped panels (browser,
  // workspace) record their activation there, so the artifact and session
  // surfaces share one mounted browser instead of tearing it down whenever the
  // dock moves between them.
  const sessionScopeKey = sessionWorkbenchScopeKey(workbenchInstanceId, activeSessionId)
  const layout = useContextWorkbenchStore((state) => state.layouts[scopeKey])
  const [selectionState, setSelectionState] = useState<
    { artifactId: string; start: number; end: number } | undefined
  >()
  const [pendingSelectionComment, setPendingSelectionComment] = useState<string | null>(null)
  const textSelection = useMemo(
    () =>
      selectionState?.artifactId === artifactId && selectionState.start !== selectionState.end
        ? { kind: "text" as const, start: selectionState.start, end: selectionState.end }
        : undefined,
    [artifactId, selectionState]
  )
  const workspaceAvailable = hasWorkspaceFsBackend()
  const dockWidthHint = useDockWidthHint()
  const resolvedDockMode = useResolvedDockMode()
  const resetDockLayout = useArtifactDockLayoutStore((state) => state.resetLayout)
  // The same panels back the desktop dock and the Sheet hosts, so the host —
  // not the viewport — decides the density. Hardcoding "desktop" here mounted
  // Monaco and the split tab inside the phone Sheet.
  const hostLayout = mobile?.panelMode ?? "desktop"
  // Only claim the header's leading slot when there are tabs to put in it; an
  // element that renders null would still displace the panel's group tabs.
  const hasArtifactTabs = useOpenArtifactTabs(showSingleArtifactTab).length > 0
  // DockWorkspace only distinguishes touch from pointer density.
  const workspaceLayout = hostLayout === "mobile" ? "mobile" : "desktop"
  const pendingRunLearningCount = useLiveQuery(
    () =>
      activeSessionId
        ? countPendingSessionRunLearningProposals(activeSessionId)
        : Promise.resolve(0),
    [activeSessionId],
    0
  )

  useEffect(() => {
    const handleSelection = (event: Event) => {
      const detail = (event as CustomEvent<{ artifactId: string; start: number; end: number }>)
        .detail
      if (detail.artifactId === artifactId) setSelectionState(detail)
    }
    window.addEventListener("artifact-context-selection", handleSelection)
    return () => window.removeEventListener("artifact-context-selection", handleSelection)
  }, [artifactId])

  // A scope with no history opens on the preview — but that rule is not written
  // here. `reconcilePanels` already falls back to the lowest-ordered panel, and
  // `preview` now *is* that panel, so the workbench seeds itself. This used to
  // be a second, opposite write racing the reconcile: whichever effect ran last
  // won, and it only landed on the preview because child effects happen to run
  // before parent ones.

  useEffect(() => {
    const appeared = !hadPendingReview.current && pendingReview !== null
    hadPendingReview.current = pendingReview !== null
    // Only widen when the reveal actually took: `smartReveal` declines while
    // the user has the workbench pinned (it queues a badge instead), and
    // resizing the dock for a panel that never came forward would be a
    // uninvited jolt.
    if (appeared && smartReveal(scopeKey, "proposal-review", "wide")) {
      dockWidthHint("wide", "proposal-review")
    }
  }, [dockWidthHint, pendingReview, scopeKey, smartReveal])

  const surfacePanels = useArtifactSurfacePanels({
    artifactId,
    artifact,
    activeSessionId,
    sessionProject,
    hostLayout,
    workspaceLayout,
    workspaceAvailable,
    pendingReview,
    unresolvedCommentCount,
    pendingRunLearningCount,
    textSelection,
    pendingSelectionComment,
    onPendingSelectionComment: setPendingSelectionComment,
    scopeKey,
    onWidthHint: dockWidthHint,
  })
  // On the desktop dock the conversation-wide panels (browser, workspace,
  // project overview) are tabs of their own on the strip (ADR-0214, D6), so
  // the artifact surface keeps only the artifact's views. Drawn here as well,
  // they would put a browser on screen under a highlighted artifact tab. The
  // phone Sheet keeps them: it has no strip to hold them.
  const panels = useMemo(
    () => (mobile ? surfacePanels : surfacePanels.filter((panel) => panel.scope !== "session")),
    [mobile, surfacePanels]
  )
  // A reveal aimed at one of those (a link opening the browser, an Edit
  // review opening the workspace) parks the artifact — its tab stays — so the
  // session surface comes up and takes the reveal as its own.
  const revealIntent = useArtifactDockLayoutStore((state) => state.revealIntent)
  const revealTargetsSessionTab =
    !mobile &&
    revealIntent !== null &&
    !panels.some((panel) => panel.id === revealIntent.panelId) &&
    revealIntent.panelId in DOCK_SESSION_PANEL_META
  useEffect(() => {
    if (revealTargetsSessionTab)
      useArtifactStore.getState().setActiveArtifact(null, activeSessionId)
  }, [activeSessionId, revealTargetsSessionTab])
  // Claim no panels when the artifact is gone: the fallback below mounts the
  // session workbench as a child, and both would otherwise race to consume the
  // same one-shot reveal intent — with this dead scope usually winning.
  useDockPanelSync(
    scopeKey,
    artifact ? panels.map((panel) => panel.id) : EMPTY_PANEL_IDS,
    artifact ? layout?.activePanelId : null,
    dockWidthHint
  )

  // Memoised because the workbench registers this host keyed on the resource's
  // *identity*: a fresh object every render tore the registration down and put
  // it back with an empty panel list, and `publishActiveContextPanels` only
  // re-publishes when the panel set itself changes. Everything reaching the
  // dock from outside — the command palette's reveal, the activity shortcuts,
  // a plugin asking for its panel — resolves through that list, so a rebuilt
  // object silently made all of them no-ops.
  const resource = useMemo<ContextResource | null>(
    () =>
      artifact
        ? {
            kind: "artifact",
            artifactId,
            version: String(artifact.version),
            selection: textSelection,
            capabilities: resolveContextCapabilities({
              kind: "artifact",
              previewable: true,
              runnable: artifact.metadata?.runnable ?? isRunnableArtifactType(artifact.type),
              workspaceAvailable,
            }),
          }
        : null,
    [artifact, artifactId, textSelection, workspaceAvailable]
  )

  // Stable props, so the memoised workbench skips renders of this surface that
  // change nothing it draws.
  const collapseDock = useCallback(() => setDockCollapsed(true), [setDockCollapsed])
  const ensureDockVisible = useCallback(() => setDockCollapsed(false), [setDockCollapsed])
  const tabStrip = useMemo(
    () => (
      <DockTabStrip
        sessionId={activeSessionId}
        sessionScopeKey={sessionScopeKey}
        onWidthHint={dockWidthHint}
      />
    ),
    [activeSessionId, dockWidthHint, sessionScopeKey]
  )

  // The id outlived its artifact (evicted by the persist cap, or cleared in
  // another tab). Fall through to the session workbench so the dock keeps a
  // single shell.
  if (!resource) return <SessionContextWorkbench mobile={mobile} railOnly={railOnly} />

  return mobile ? (
    <ContextWorkbenchMobileDrawer
      open={mobile.open}
      onOpenChange={mobile.onOpenChange}
      workbenchInstanceId={workbenchInstanceId}
      resource={resource}
      panels={panels}
      sessionScopeKey={sessionScopeKey}
      // The drawer needs the tabs as much as the dock does — without them a
      // phone has no way to move between open artifacts at all.
      headerLeading={
        hasArtifactTabs ? (
          <ArtifactTabStrip showSingle={showSingleArtifactTab} className="min-w-0 flex-1" />
        ) : undefined
      }
      onEnsureVisible={() => mobile.onOpenChange(true)}
      snapPoint={mobileSnapPoint}
      onSnapPointChange={setMobileSnapPoint}
    />
  ) : (
    <ContextWorkbench
      workbenchInstanceId={workbenchInstanceId}
      resource={resource}
      panels={panels}
      sessionScopeKey={sessionScopeKey}
      onCollapse={collapseDock}
      onEnsureVisible={ensureDockVisible}
      railOnly={railOnly}
      concealed={concealed}
      attentionActivity={unreadArtifact ? ARTIFACT_ATTENTION_ACTIVITY : undefined}
      onModeWidthHint={dockWidthHint}
      resolvedMode={resolvedDockMode}
      onResetLayout={resetDockLayout}
      tabStrip="external"
      resourcePanelSwitcher
      headerLeading={tabStrip}
      placement="chat-dock"
      manageOwnWidth={false}
      className="w-full"
    />
  )
}

/**
 * The dock's surface when no artifact is active. Hosts the session-scoped
 * panels (artifact history, embedded browser, workspace) inside the *same*
 * workbench chrome the artifact surface uses, so the chat right rail never
 * changes shape.
 */
export function SessionContextWorkbench({
  mobile,
  railOnly,
  concealed,
  inBackground = false,
}: {
  mobile?: SheetHost
  railOnly?: boolean
  /** Kept mounted off screen (`ContextWorkbench`'s `concealed`). */
  concealed?: boolean
  /** Kept mounted behind the artifact surface, which is the one in front. */
  inBackground?: boolean
}) {
  const workbenchInstanceId = useContextWorkbenchInstanceId(ARTIFACT_DOCK_WORKBENCH_HOST_KEY)
  const showSingleArtifactTab = useContextWorkbenchStore(
    (state) => state.navigationStyle !== "rail"
  )
  const activeSessionId = useChatStore((state) => state.activeSessionId)
  // Query the same persisted record as the chat. The plugin session adapter is
  // lazy and may never load in an ordinary conversation.
  const sessionRecord = useClientLiveQuery(
    () => (activeSessionId ? getSession(activeSessionId) : Promise.resolve(undefined)),
    [activeSessionId],
    undefined
  )
  const session = sessionRecord?.id === activeSessionId ? sessionRecord : null
  const sessionProject = useProjectStore((state) =>
    session?.projectId
      ? state.projects.find((project) => project.id === session.projectId)
      : undefined
  )
  const messageCount = useChatStore((state) =>
    activeSessionId ? (state.sessions[activeSessionId]?.messages.length ?? 0) : 0
  )
  const unresolvedCommentCount = useContextCommentBadge("session", activeSessionId)
  const setDockCollapsed = useArtifactDockLayoutStore((state) => state.setDockCollapsed)
  const mobileSnapPoint = useArtifactDockLayoutStore((state) => state.mobileSnapPoint)
  const setMobileSnapPoint = useArtifactDockLayoutStore((state) => state.setMobileSnapPoint)
  const unreadArtifact = useArtifactDockLayoutStore((state) => state.unreadArtifact)
  const workspaceAvailable = hasWorkspaceFsBackend()
  const workspaceLayout = mobile?.panelMode === "mobile" ? "mobile" : "desktop"
  const dockWidthHint = useDockWidthHint()
  const resolvedDockMode = useResolvedDockMode()
  const resetDockLayout = useArtifactDockLayoutStore((state) => state.resetLayout)
  const scopeKey = sessionWorkbenchScopeKey(workbenchInstanceId, activeSessionId)
  const activePanelId = useContextWorkbenchStore(
    (state) => state.layouts[scopeKey]?.activePanelId ?? null
  )
  // Once tabs are bucketed per conversation, "this session has open tabs but no
  // active artifact" is an ordinary state — closing the last artifact you were
  // reading, or coming back to a conversation whose active tab was evicted. The
  // strip used to vanish entirely there, stranding every other open artifact.
  const hasArtifactTabs = useOpenArtifactTabs(showSingleArtifactTab).length > 0
  const pendingRunLearningCount = useLiveQuery(
    () =>
      activeSessionId
        ? countPendingSessionRunLearningProposals(activeSessionId)
        : Promise.resolve(0),
    [activeSessionId],
    0
  )
  // The rail badges read the same walks as the session summary card, so the
  // numbers on the card and on the rail never disagree. Selected as the count,
  // not as the message list: this component renders the whole workbench, and
  // subscribing it to the transcript re-rendered every panel body on each
  // streamed token for a number that changes a few times per conversation.
  const sourceCount = useChatStore((state) =>
    activeSessionId ? countSessionSources(state.sessions[activeSessionId]?.messages) : 0
  )
  const uncommittedChangeCount = useSessionResourceChanges(activeSessionId).totals.files

  const panels = useSessionSurfacePanels({
    activeSessionId,
    session,
    sessionProject,
    workspaceLayout,
    workspaceAvailable,
    unresolvedCommentCount,
    sourceCount,
    uncommittedChangeCount,
    pendingRunLearningCount,
    scopeKey,
    onWidthHint: dockWidthHint,
    newTab: !mobile,
  })
  useDockPanelSync(
    scopeKey,
    panels.map((panel) => panel.id),
    activePanelId,
    dockWidthHint,
    !inBackground
  )

  // Memoised for the same reason as the artifact surface's: the host
  // registration is keyed on this object's identity.
  const resource = useMemo<ContextResource>(
    () => ({
      kind: "session",
      // A dock with no conversation still needs a stable scope key.
      sessionId: activeSessionId ?? "none",
      capabilities: resolveContextCapabilities({ kind: "session", workspaceAvailable }),
    }),
    [activeSessionId, workspaceAvailable]
  )

  const overview = useMemo<SessionOverviewContextValue | null>(
    () =>
      session
        ? {
            session,
            messageCount,
            onNavigate: (panelId) => {
              useContextWorkbenchStore.getState().navigatePanel(scopeKey, panelId, "wide")
            },
          }
        : null,
    [messageCount, scopeKey, session]
  )
  const collapseDock = useCallback(() => setDockCollapsed(true), [setDockCollapsed])
  const ensureDockVisible = useCallback(() => setDockCollapsed(false), [setDockCollapsed])
  const tabStrip = useMemo(
    () => (
      <DockTabStrip
        sessionId={activeSessionId}
        sessionScopeKey={scopeKey}
        onWidthHint={dockWidthHint}
      />
    ),
    [activeSessionId, dockWidthHint, scopeKey]
  )

  return (
    <SessionOverviewContext.Provider value={overview}>
      {mobile ? (
        <ContextWorkbenchMobileDrawer
          open={mobile.open}
          onOpenChange={mobile.onOpenChange}
          workbenchInstanceId={workbenchInstanceId}
          resource={resource}
          panels={panels}
          headerLeading={
            hasArtifactTabs ? (
              <ArtifactTabStrip showSingle={showSingleArtifactTab} className="min-w-0 flex-1" />
            ) : undefined
          }
          onEnsureVisible={() => mobile.onOpenChange(true)}
          snapPoint={mobileSnapPoint}
          onSnapPointChange={setMobileSnapPoint}
        />
      ) : (
        <ContextWorkbench
          workbenchInstanceId={workbenchInstanceId}
          resource={resource}
          panels={panels}
          tabStrip="external"
          headerLeading={tabStrip}
          onCollapse={collapseDock}
          onEnsureVisible={ensureDockVisible}
          railOnly={railOnly}
          concealed={concealed}
          attentionActivity={unreadArtifact ? SESSION_ATTENTION_ACTIVITY : undefined}
          onModeWidthHint={dockWidthHint}
          resolvedMode={resolvedDockMode}
          onResetLayout={resetDockLayout}
          placement="chat-dock"
          manageOwnWidth={false}
          className="w-full"
        />
      )}
    </SessionOverviewContext.Provider>
  )
}

export default ArtifactDock
