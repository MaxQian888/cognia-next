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

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { hasWorkspaceFsBackend } from "@/lib/files/workspace-backend"
import { isRunnableArtifactType } from "@/lib/artifacts/constants"
import { useChatStore } from "@/stores/chat"
import { useSessionStore } from "@/stores/chat/session-store"
import {
  DOCK_MODE_WIDTH_PERCENT,
  useArtifactDockLayoutStore,
} from "@/stores/artifact/artifact-dock-layout-store"
import type { ArtifactPanelMode } from "./artifact-panel-content"
import { ArtifactTabStrip, useOpenArtifactTabs } from "./artifact-tab-strip"
import {
  PROJECT_OVERVIEW_PANEL_ID,
  WORKSPACE_PANEL_ID,
  useArtifactSurfacePanels,
  useSessionSurfacePanels,
} from "./chat-dock-panels"
import {
  ContextWorkbench,
  ContextWorkbenchMobileSheet,
} from "@/components/context-workbench/context-workbench"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useActiveArtifactId } from "@/hooks/artifacts/use-session-artifacts"
import { useContextWorkbenchStore } from "@/stores/context-workbench/context-workbench-store"
import type { ContextPanelMode, ContextResource } from "@/types/context-workbench"
import { useContextWorkbenchInstanceId } from "@/hooks/context-workbench/use-context-workbench-instance-id"
import { resolveContextCapabilities } from "@/lib/context-workbench/capabilities"
import { useContextCommentBadge } from "@/hooks/context-workbench/use-context-comment-badge"
import { useProjectStore } from "@/stores/project/project-store"
import type { UIMessage } from "ai"

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

export function ArtifactDock({ railOnly }: { railOnly?: boolean }) {
  const activeArtifactId = useActiveArtifactId()
  // The only branch in the dock: which resource backs the one workbench shell.
  // The browser used to force a surface swap because it is session-scoped; it
  // is now a panel on both surfaces, so opening it keeps your artifact context.
  return activeArtifactId ? (
    <ArtifactContextWorkbench artifactId={activeArtifactId} railOnly={railOnly} />
  ) : (
    <SessionContextWorkbench railOnly={railOnly} />
  )
}

/**
 * The dock is mounted with `manageOwnWidth={false}` — its width belongs to the
 * outer ResizablePanel — so the workbench header's narrow/wide buttons have to
 * resize the dock instead of the workbench, or they do nothing at all. The
 * preset table is keyed by profile so "wide" reaches the workspace cap (65%)
 * rather than the artifact one (50%).
 *
 * Two callers, two contracts (see `onModeWidthHint`): a panel activation names
 * its panel and is applied as a high-water mark; the header buttons name none
 * and apply unconditionally.
 */
function useDockWidthHint() {
  const requestDockSize = useArtifactDockLayoutStore((state) => state.requestDockSize)
  const dockProfile = useArtifactDockLayoutStore((state) => state.dockProfile)
  return useCallback(
    (mode: ContextPanelMode, panelId?: string) => {
      // Focus is a full-screen takeover; it owns no dock width.
      if (mode === "focus") return
      // Derive the profile from the panel that is arriving rather than reading
      // `dockProfile`. That field is written by `useDockPanelSync` in an effect
      // that runs *after* `activePanelId` changes, so during the activation
      // itself it still holds the outgoing panel's profile — activating the
      // workspace would look up `compact.wide` (50%) instead of
      // `workspace.wide` (65%), silently under-delivering exactly where the
      // extra room matters most. Only the header buttons, which name no panel,
      // fall back to the settled profile.
      const profile = panelId
        ? panelId === WORKSPACE_PANEL_ID || panelId === PROJECT_OVERVIEW_PANEL_ID
          ? "workspace"
          : "compact"
        : dockProfile
      const target = DOCK_MODE_WIDTH_PERCENT[profile][mode]
      // High-water mark: a panel's `preferredMode` may widen the dock, never
      // narrow it. Otherwise moving from the workspace back to the preview
      // would yank a width the user had dragged to back down to the preset,
      // and the dock would feel like it was fighting the pointer. Narrowing
      // stays available through the header's narrow button and the divider.
      if (panelId && target <= useArtifactDockLayoutStore.getState().dockSize) return
      requestDockSize(target)
    },
    [dockProfile, requestDockSize]
  )
}

/**
 * The scope key standing in for "this conversation". Built in one place because
 * both dock surfaces need the identical string: the session surface uses it as
 * its own layout scope, and the artifact surface hands it to the workbench so
 * `scope: "session"` panels record their activation against the conversation.
 */
function sessionWorkbenchScopeKey(
  workbenchInstanceId: string,
  activeSessionId: string | null
): string {
  return `${workbenchInstanceId}::session:${activeSessionId ?? "none"}`
}

/**
 * Which width preset the dock is *actually* sitting at, for the workbench
 * header's narrow/wide highlight.
 *
 * The dock's width lives in `dockSize`, not in `layout.mode`: mounted with
 * `manageOwnWidth={false}`, the workbench never applies its own width, so that
 * field only ever coloured two buttons. Because a panel activation writes the
 * mode while `useDockWidthHint` applies it as a high-water mark, the two drifted
 * apart the moment a `preferredMode: "wide"` panel handed back to a narrow one —
 * the button said narrow over a 65%-wide dock. Deriving it from the width means
 * the highlight cannot lie, and dragging the divider updates it for free.
 */
function useResolvedDockMode(): ContextPanelMode {
  const dockSize = useArtifactDockLayoutStore((state) => state.dockSize)
  const dockProfile = useArtifactDockLayoutStore((state) => state.dockProfile)
  const presets = DOCK_MODE_WIDTH_PERCENT[dockProfile]
  // Midpoint rather than an exact match: the user can drag anywhere between the
  // two presets, and every width above the halfway mark reads as "wide".
  return dockSize >= (presets.narrow + presets.wide) / 2 ? "wide" : "narrow"
}

/**
 * Keep the dock's sizing profile in step with whichever panel is showing, and
 * consume any one-shot reveal intent this surface can satisfy.
 *
 * This is the ONLY writer of `dockProfile`, and it is strictly one-directional:
 * panel → profile. The predecessor (`dockMode`) was written by panel lifecycle
 * hooks *and* read back to order the panel list, so a fresh scope could
 * activate an unrelated panel, have it write the mode, and bounce the dock out
 * of the surface the user asked for.
 */
function useDockPanelSync(
  scopeKey: string,
  panelIds: string[],
  activePanelId: string | null | undefined,
  onWidthHint: (mode: ContextPanelMode, panelId?: string) => void
) {
  const setDockProfile = useArtifactDockLayoutStore((state) => state.setDockProfile)
  const revealIntent = useArtifactDockLayoutStore((state) => state.revealIntent)
  const consumeRevealIntent = useArtifactDockLayoutStore((state) => state.consumeRevealIntent)
  const dockCollapsed = useArtifactDockLayoutStore((state) => state.dockCollapsed)
  const navigatePanel = useContextWorkbenchStore((state) => state.navigatePanel)
  const setMode = useContextWorkbenchStore((state) => state.setMode)
  const isFocus = useContextWorkbenchStore((state) => state.layouts[scopeKey]?.mode === "focus")

  useEffect(() => {
    if (!activePanelId) return
    setDockProfile(
      activePanelId === WORKSPACE_PANEL_ID || activePanelId === PROJECT_OVERVIEW_PANEL_ID
        ? "workspace"
        : "compact"
    )
  }, [activePanelId, setDockProfile])

  // Focus is a full-screen takeover that outlives the dock it was opened from.
  // The workbench's own collapse button drops it on the way out, but the three
  // routes users actually reach for — ⌘J, the desktop Views menu, the chat
  // header toggle — write `dockCollapsed` directly and never touch the mode. The
  // overlay then vanished with the dock's content 240ms later while the mode
  // persisted, so re-opening came back `fixed inset-0 z-50` over the whole app.
  // This seam is the only one that can see both facts, so the rule lives here.
  useEffect(() => {
    if (!dockCollapsed || !isFocus) return
    setMode(scopeKey, "narrow")
  }, [dockCollapsed, isFocus, scopeKey, setMode])

  const owns = revealIntent ? panelIds.includes(revealIntent.panelId) : false
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
const EMPTY_SESSION_MESSAGES: UIMessage[] = []

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
}: {
  artifactId: string
  mobile?: SheetHost
  railOnly?: boolean
}) {
  const workbenchInstanceId = useContextWorkbenchInstanceId("artifact")
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
  // Something arrived while the dock was dismissed. With a persistent rail the
  // marker belongs on the rail itself — that is now the thing the user is
  // looking at — rather than only on the chat header's toggle.
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
  const hasArtifactTabs = useOpenArtifactTabs().length > 0
  // DockWorkspace only distinguishes touch from pointer density.
  const workspaceLayout = hostLayout === "mobile" ? "mobile" : "desktop"

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

  const panels = useArtifactSurfacePanels({
    artifactId,
    artifact,
    activeSessionId,
    sessionProject,
    hostLayout,
    workspaceLayout,
    workspaceAvailable,
    pendingReview,
    unresolvedCommentCount,
    textSelection,
    pendingSelectionComment,
    onPendingSelectionComment: setPendingSelectionComment,
    scopeKey,
    onWidthHint: dockWidthHint,
  })
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

  // The id outlived its artifact (evicted by the persist cap, or cleared in
  // another tab). Fall through to the session workbench so the dock keeps a
  // single shell.
  if (!resource) return <SessionContextWorkbench mobile={mobile} railOnly={railOnly} />

  return mobile ? (
    <ContextWorkbenchMobileSheet
      open={mobile.open}
      onOpenChange={mobile.onOpenChange}
      workbenchInstanceId={workbenchInstanceId}
      resource={resource}
      panels={panels}
      sessionScopeKey={sessionScopeKey}
      // The Sheet needs the tabs as much as the dock does — without them a
      // phone has no way to move between open artifacts at all.
      headerLeading={hasArtifactTabs ? <ArtifactTabStrip className="flex-1" /> : undefined}
      onCollapse={() => mobile.onOpenChange(false)}
      onEnsureVisible={() => mobile.onOpenChange(true)}
    />
  ) : (
    <ContextWorkbench
      workbenchInstanceId={workbenchInstanceId}
      resource={resource}
      panels={panels}
      sessionScopeKey={sessionScopeKey}
      onCollapse={() => setDockCollapsed(true)}
      onEnsureVisible={() => setDockCollapsed(false)}
      railOnly={railOnly}
      attentionActivity={unreadArtifact ? ARTIFACT_ATTENTION_ACTIVITY : undefined}
      onModeWidthHint={dockWidthHint}
      resolvedMode={resolvedDockMode}
      onResetLayout={resetDockLayout}
      headerLeading={hasArtifactTabs ? <ArtifactTabStrip className="flex-1" /> : undefined}
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
}: {
  mobile?: SheetHost
  railOnly?: boolean
}) {
  const workbenchInstanceId = useContextWorkbenchInstanceId("artifact")
  const activeSessionId = useChatStore((state) => state.activeSessionId)
  // The conversation's *record* (model, working dir, timestamps) lives in
  // `sessionStore`; `chatStore.sessions` is the per-session message slice.
  const session = useSessionStore((state) =>
    activeSessionId ? (state.sessions.find((s) => s.id === activeSessionId) ?? null) : null
  )
  const sessionProject = useProjectStore((state) =>
    session?.projectId
      ? state.projects.find((project) => project.id === session.projectId)
      : undefined
  )
  const messageCount = useChatStore((state) =>
    activeSessionId ? (state.sessions[activeSessionId]?.messages.length ?? 0) : 0
  )
  const sessionMessages = useChatStore((state) =>
    activeSessionId
      ? (state.sessions[activeSessionId]?.messages ?? EMPTY_SESSION_MESSAGES)
      : EMPTY_SESSION_MESSAGES
  )
  const unresolvedCommentCount = useContextCommentBadge("session", activeSessionId)
  const setDockCollapsed = useArtifactDockLayoutStore((state) => state.setDockCollapsed)
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
  const hasArtifactTabs = useOpenArtifactTabs().length > 0

  const panels = useSessionSurfacePanels({
    activeSessionId,
    session,
    sessionProject,
    sessionMessages,
    messageCount,
    workspaceLayout,
    workspaceAvailable,
    unresolvedCommentCount,
    scopeKey,
    onWidthHint: dockWidthHint,
  })
  useDockPanelSync(
    scopeKey,
    panels.map((panel) => panel.id),
    activePanelId,
    dockWidthHint
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

  return mobile ? (
    <ContextWorkbenchMobileSheet
      open={mobile.open}
      onOpenChange={mobile.onOpenChange}
      workbenchInstanceId={workbenchInstanceId}
      resource={resource}
      panels={panels}
      headerLeading={hasArtifactTabs ? <ArtifactTabStrip className="flex-1" /> : undefined}
      onCollapse={() => mobile.onOpenChange(false)}
      onEnsureVisible={() => mobile.onOpenChange(true)}
    />
  ) : (
    <ContextWorkbench
      workbenchInstanceId={workbenchInstanceId}
      resource={resource}
      panels={panels}
      headerLeading={hasArtifactTabs ? <ArtifactTabStrip className="flex-1" /> : undefined}
      onCollapse={() => setDockCollapsed(true)}
      onEnsureVisible={() => setDockCollapsed(false)}
      railOnly={railOnly}
      attentionActivity={unreadArtifact ? SESSION_ATTENTION_ACTIVITY : undefined}
      onModeWidthHint={dockWidthHint}
      resolvedMode={resolvedDockMode}
      onResetLayout={resetDockLayout}
      placement="chat-dock"
      manageOwnWidth={false}
      className="w-full"
    />
  )
}

export default ArtifactDock
