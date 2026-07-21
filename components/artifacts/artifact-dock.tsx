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

import {
  BotIcon,
  History,
  MessageSquareIcon,
  PanelsTopLeftIcon,
  SearchCodeIcon,
  InfoIcon,
  GlobeIcon,
} from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { hasWorkspaceFsBackend } from "@/lib/files/workspace-backend"
import { useChatStore } from "@/stores/chat"
import {
  DOCK_MODE_WIDTH_PERCENT,
  useArtifactDockLayoutStore,
} from "@/stores/artifact/artifact-dock-layout-store"
import { ArtifactPanelContent, type ArtifactPanelMode } from "./artifact-panel-content"
import { ArtifactList } from "./artifact-list"
import { DockWorkspace } from "./workspace-mode/dock-workspace"
import {
  ContextWorkbench,
  ContextWorkbenchMobileSheet,
} from "@/components/context-workbench/context-workbench"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useContextWorkbenchStore } from "@/stores/context-workbench/context-workbench-store"
import type {
  ContextPanelDefinition,
  ContextPanelMode,
  ContextResource,
} from "@/types/context-workbench"
import { ResourceWorkbenchChatPanel } from "@/components/context-workbench/resource-workbench-chat-panel"
import { ArtifactReviewView } from "./artifact-review-view"
import { ContextMetadataPanel } from "@/components/context-workbench/context-metadata-panel"
import { useContextWorkbenchInstanceId } from "@/hooks/context-workbench/use-context-workbench-instance-id"
import { ContextCommentsPanel } from "@/components/context-workbench/context-comments-panel"
import { ContextCapabilityUnavailable } from "@/components/context-workbench/context-capability-unavailable"
import { resolveContextCapabilities } from "@/lib/context-workbench/capabilities"
import { useContextCommentBadge } from "@/hooks/context-workbench/use-context-comment-badge"
import { BrowserPreviewPane } from "@/components/browser/browser-preview-pane"

export function ArtifactDock() {
  const activeArtifactId = useArtifactStore((state) => state.activeArtifactId)
  // The only branch in the dock: which resource backs the one workbench shell.
  // The browser used to force a surface swap because it is session-scoped; it
  // is now a panel on both surfaces, so opening it keeps your artifact context.
  return activeArtifactId ? (
    <ArtifactContextWorkbench artifactId={activeArtifactId} />
  ) : (
    <SessionContextWorkbench />
  )
}

/**
 * The dock is mounted with `manageOwnWidth={false}` — its width belongs to the
 * outer ResizablePanel — so the workbench header's narrow/wide buttons have to
 * resize the dock instead of the workbench, or they do nothing at all. The
 * preset table is keyed by profile so "wide" reaches the workspace cap (65%)
 * rather than the artifact one (50%).
 */
function useDockWidthHint() {
  const requestDockSize = useArtifactDockLayoutStore((state) => state.requestDockSize)
  const dockProfile = useArtifactDockLayoutStore((state) => state.dockProfile)
  return useCallback(
    (mode: ContextPanelMode) => {
      // Focus is a full-screen takeover; it owns no dock width.
      if (mode === "focus") return
      requestDockSize(DOCK_MODE_WIDTH_PERCENT[dockProfile][mode])
    },
    [dockProfile, requestDockSize]
  )
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
function useDockPanelSync(scopeKey: string, panelIds: string[], activePanelId?: string | null) {
  const setDockProfile = useArtifactDockLayoutStore((state) => state.setDockProfile)
  const revealIntent = useArtifactDockLayoutStore((state) => state.revealIntent)
  const consumeRevealIntent = useArtifactDockLayoutStore((state) => state.consumeRevealIntent)
  const navigatePanel = useContextWorkbenchStore((state) => state.navigatePanel)

  useEffect(() => {
    if (!activePanelId) return
    setDockProfile(activePanelId === "workspace" ? "workspace" : "compact")
  }, [activePanelId, setDockProfile])

  const owns = revealIntent ? panelIds.includes(revealIntent.panelId) : false
  useEffect(() => {
    if (!revealIntent || !owns) return
    navigatePanel(scopeKey, revealIntent.panelId, revealIntent.mode)
    consumeRevealIntent(revealIntent.panelId)
  }, [consumeRevealIntent, navigatePanel, owns, revealIntent, scopeKey])
}

/** Stable identity so the sync effects don't re-run on every render. */
const EMPTY_PANEL_IDS: string[] = []

export function ArtifactContextWorkbench({
  artifactId,
  mobile,
}: {
  artifactId: string
  /**
   * Set by the Sheet host (`<ArtifactPanel />`). `panelMode` is the host's own
   * density decision — tablet still wants Monaco, only a phone drops to the
   * light editor — so the panels must not re-derive it from the viewport.
   */
  mobile?: {
    open: boolean
    onOpenChange: (open: boolean) => void
    panelMode: ArtifactPanelMode
  }
}) {
  const tWorkbench = useTranslations("contextWorkbench")
  const workbenchInstanceId = useContextWorkbenchInstanceId("artifact")
  const artifact = useArtifactStore((state) => state.artifacts[artifactId])
  const unresolvedCommentCount = useContextCommentBadge("artifact", artifactId)
  const pendingReview = useArtifactStore((state) => state.pendingReviews[artifactId] ?? null)
  const hadPendingReview = useRef(false)
  const activeSessionId = useChatStore((state) => state.activeSessionId)
  const setDockCollapsed = useArtifactDockLayoutStore((state) => state.setDockCollapsed)
  const navigatePanel = useContextWorkbenchStore((state) => state.navigatePanel)
  const smartReveal = useContextWorkbenchStore((state) => state.smartReveal)
  const scopeKey = `${workbenchInstanceId}::artifact:${artifactId}`
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
  // The same panels back the desktop dock and the Sheet hosts, so the host —
  // not the viewport — decides the density. Hardcoding "desktop" here mounted
  // Monaco and the split tab inside the phone Sheet.
  const hostLayout = mobile?.panelMode ?? "desktop"
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

  // A scope with no history opens on the preview. Everything else is restored
  // by `reconcilePanels` from the persisted layout, so this must not run again.
  // Skipped without an artifact, or a dead id would seed a layout entry against
  // the workbench's 200-scope persistence budget for a surface never rendered.
  useEffect(() => {
    if (!artifact || layout?.activePanelId) return
    navigatePanel(scopeKey, "preview", "narrow")
  }, [artifact, layout?.activePanelId, navigatePanel, scopeKey])

  useEffect(() => {
    const appeared = !hadPendingReview.current && pendingReview !== null
    hadPendingReview.current = pendingReview !== null
    if (appeared) smartReveal(scopeKey, "proposal-review", "wide")
  }, [pendingReview, scopeKey, smartReveal])

  const panels = useMemo<ContextPanelDefinition[]>(
    () => [
      {
        id: "resource-chat",
        activity: "ai",
        labelKey: "contextWorkbench.resourceChat",
        icon: BotIcon,
        order: 5,
        appliesTo: (resource) => resource.kind === "artifact",
        retention: "stateful",
        requiresChatScope: true,
        renderer: () => (
          <ResourceWorkbenchChatPanel
            getResourceContext={() => artifact?.content ?? ""}
            pendingPrompt={pendingSelectionComment}
            onPendingPromptConsumed={() => setPendingSelectionComment(null)}
          />
        ),
      },
      {
        id: "comments",
        activity: "comments",
        labelKey: "contextWorkbench.comments",
        icon: MessageSquareIcon,
        order: 10,
        appliesTo: (resource) => resource.kind === "artifact",
        retention: "stateful",
        getBadge: () => unresolvedCommentCount,
        renderer: () =>
          artifact ? (
            <ContextCommentsPanel
              resource={{ kind: "artifact", id: artifactId, projectId: artifact.projectId }}
              revision={String(artifact.version)}
              anchor={
                textSelection
                  ? {
                      kind: "text-range",
                      start: textSelection.start,
                      end: textSelection.end,
                      revision: String(artifact.version),
                    }
                  : undefined
              }
            />
          ) : null,
      },
      {
        id: "selection-ai",
        activity: "ai",
        labelKey: "contextWorkbench.aiActions",
        icon: BotIcon,
        order: 12,
        appliesTo: (resource) => resource.kind === "artifact",
        retention: "stateful",
        renderer: () => (
          <ArtifactSelectionCommentPanel
            hasSelection={Boolean(textSelection)}
            onSubmit={(comment) => {
              setPendingSelectionComment(comment)
              navigatePanel(scopeKey, "resource-chat", "narrow")
            }}
          />
        ),
      },
      {
        id: "proposal-review",
        activity: "review",
        labelKey: "contextWorkbench.proposalReview",
        icon: History,
        order: 15,
        appliesTo: (resource) => resource.kind === "artifact",
        retention: "stateful",
        preferredMode: "wide",
        getBadge: () => (pendingReview ? 1 : 0),
        renderer: () =>
          artifact ? <ArtifactReviewView artifact={artifact} panelMode={hostLayout} /> : null,
      },
      {
        id: "preview",
        activity: "preview-run",
        labelKey: "artifacts.dock.artifactMode",
        icon: PanelsTopLeftIcon,
        order: 10,
        appliesTo: (resource) => resource.kind === "artifact",
        retention: "stateful",
        renderer: () => <ArtifactPanelContent panelMode={hostLayout} />,
      },
      {
        // Session-scoped content on an artifact-scoped surface, deliberately:
        // grouped with the preview so reaching the browser costs one click and
        // never drops the artifact you were looking at.
        id: "browser",
        activity: "preview-run",
        labelKey: "browser.title",
        icon: GlobeIcon,
        order: 11,
        appliesTo: (resource) => resource.kind === "artifact",
        retention: "stateful",
        preferredMode: "wide",
        renderer: () => <BrowserPreviewPane sessionId={activeSessionId ?? undefined} />,
      },
      {
        id: "history",
        activity: "review",
        labelKey: "artifacts.dock.showHistory",
        icon: History,
        order: 20,
        appliesTo: (resource) => resource.kind === "artifact",
        retention: "stateful",
        preferredMode: "wide",
        renderer: () => (
          <ArtifactList
            sessionId={activeSessionId ?? undefined}
            className="h-full"
            maxHeight="100%"
          />
        ),
      },
      {
        id: "metadata",
        activity: "inspect",
        labelKey: "contextWorkbench.metadata.artifactTitle",
        icon: InfoIcon,
        order: 25,
        appliesTo: (resource) => resource.kind === "artifact",
        retention: "stateful",
        renderer: () =>
          artifact ? (
            <ContextMetadataPanel
              title={tWorkbench("metadata.artifactTitle")}
              fields={[
                { label: tWorkbench("metadata.artifactType"), value: artifact.type },
                {
                  label: tWorkbench("metadata.language"),
                  value: artifact.language ?? tWorkbench("metadata.unknown"),
                },
                { label: tWorkbench("metadata.version"), value: artifact.version },
                {
                  label: tWorkbench("metadata.runtimeStatus"),
                  value: artifact.metadata?.runtimeHealth ?? tWorkbench("metadata.notRun"),
                },
                {
                  label: tWorkbench("metadata.updatedAt"),
                  value: artifact.updatedAt.toLocaleString(),
                },
              ]}
            />
          ) : null,
      },
      {
        id: "workspace",
        activity: "inspect",
        labelKey: "artifacts.dock.workspaceMode",
        icon: SearchCodeIcon,
        order: 30,
        appliesTo: (resource) => resource.kind === "artifact",
        retention: "stateful",
        preferredMode: "wide",
        renderer: () =>
          workspaceAvailable ? (
            <DockWorkspace activeSessionId={activeSessionId} layout={workspaceLayout} />
          ) : (
            <ContextCapabilityUnavailable capability="workspace" />
          ),
      },
    ],
    [
      navigatePanel,
      activeSessionId,
      artifact,
      artifactId,
      hostLayout,
      workspaceLayout,
      pendingReview,
      pendingSelectionComment,
      scopeKey,
      tWorkbench,
      textSelection,
      unresolvedCommentCount,
      workspaceAvailable,
    ]
  )
  // Claim no panels when the artifact is gone: the fallback below mounts the
  // session workbench as a child, and both would otherwise race to consume the
  // same one-shot reveal intent — with this dead scope usually winning.
  useDockPanelSync(
    scopeKey,
    artifact ? panels.map((panel) => panel.id) : EMPTY_PANEL_IDS,
    artifact ? layout?.activePanelId : null
  )

  // The id outlived its artifact (evicted by the persist cap, or cleared in
  // another tab). Fall through to the session workbench so the dock keeps a
  // single shell.
  if (!artifact) return mobile ? null : <SessionContextWorkbench />
  const resource: ContextResource = {
    kind: "artifact",
    artifactId,
    version: String(artifact.version),
    selection: textSelection,
    capabilities: resolveContextCapabilities({
      kind: "artifact",
      previewable: true,
      runnable:
        artifact.metadata?.runnable ?? ["code", "html", "react", "jupyter"].includes(artifact.type),
      workspaceAvailable,
    }),
  }

  return mobile ? (
    <ContextWorkbenchMobileSheet
      open={mobile.open}
      onOpenChange={mobile.onOpenChange}
      workbenchInstanceId={workbenchInstanceId}
      resource={resource}
      panels={panels}
      onCollapse={() => mobile.onOpenChange(false)}
    />
  ) : (
    <ContextWorkbench
      workbenchInstanceId={workbenchInstanceId}
      resource={resource}
      panels={panels}
      onCollapse={() => setDockCollapsed(true)}
      onModeWidthHint={dockWidthHint}
      placement="chat-dock"
      manageOwnWidth={false}
      className="w-full"
    />
  )
}

function ArtifactSelectionCommentPanel({
  hasSelection,
  onSubmit,
}: {
  hasSelection: boolean
  onSubmit: (comment: string) => void
}) {
  const t = useTranslations("contextWorkbench.artifactSelectionComment")
  const [comment, setComment] = useState("")
  const canSubmit = hasSelection && comment.trim().length > 0

  return (
    <div className="space-y-3 p-3">
      <p className="text-xs text-muted-foreground">
        {hasSelection ? t("selectionReady") : t("selectFirst")}
      </p>
      <Textarea
        value={comment}
        onChange={(event) => setComment(event.target.value)}
        placeholder={t("placeholder")}
        aria-label={t("label")}
        rows={5}
      />
      <Button
        type="button"
        className="w-full"
        disabled={!canSubmit}
        onClick={() => {
          onSubmit(comment.trim())
          setComment("")
        }}
      >
        <BotIcon className="size-4" />
        {t("sendToAi")}
      </Button>
    </div>
  )
}

/**
 * The dock's surface when no artifact is active. Hosts the session-scoped
 * panels (artifact history, embedded browser, workspace) inside the *same*
 * workbench chrome the artifact surface uses, so the chat right rail never
 * changes shape.
 */
export function SessionContextWorkbench() {
  const workbenchInstanceId = useContextWorkbenchInstanceId("artifact")
  const activeSessionId = useChatStore((state) => state.activeSessionId)
  const setDockCollapsed = useArtifactDockLayoutStore((state) => state.setDockCollapsed)
  const workspaceAvailable = hasWorkspaceFsBackend()
  const dockWidthHint = useDockWidthHint()
  const scopeKey = `${workbenchInstanceId}::session:${activeSessionId ?? "none"}`
  const activePanelId = useContextWorkbenchStore(
    (state) => state.layouts[scopeKey]?.activePanelId ?? null
  )

  const panels = useMemo<ContextPanelDefinition[]>(
    () => [
      {
        id: "history",
        activity: "review",
        labelKey: "artifacts.dock.showHistory",
        icon: History,
        order: 10,
        appliesTo: (resource) => resource.kind === "session",
        retention: "stateful",
        renderer: () => (
          <ArtifactList
            sessionId={activeSessionId ?? undefined}
            className="h-full"
            maxHeight="100%"
          />
        ),
      },
      {
        id: "browser",
        activity: "preview-run",
        labelKey: "browser.title",
        icon: GlobeIcon,
        order: 20,
        appliesTo: (resource) => resource.kind === "session",
        retention: "stateful",
        preferredMode: "wide",
        renderer: () => <BrowserPreviewPane sessionId={activeSessionId ?? undefined} />,
      },
      {
        id: "workspace",
        activity: "inspect",
        labelKey: "artifacts.dock.workspaceMode",
        icon: SearchCodeIcon,
        order: 30,
        appliesTo: (resource) => resource.kind === "session",
        retention: "stateful",
        preferredMode: "wide",
        renderer: () =>
          workspaceAvailable ? (
            <DockWorkspace activeSessionId={activeSessionId} />
          ) : (
            <ContextCapabilityUnavailable capability="workspace" />
          ),
      },
    ],
    [activeSessionId, workspaceAvailable]
  )
  useDockPanelSync(
    scopeKey,
    panels.map((panel) => panel.id),
    activePanelId
  )

  const resource: ContextResource = {
    kind: "session",
    // A dock with no conversation still needs a stable scope key.
    sessionId: activeSessionId ?? "none",
    capabilities: resolveContextCapabilities({ kind: "session", workspaceAvailable }),
  }

  return (
    <ContextWorkbench
      workbenchInstanceId={workbenchInstanceId}
      resource={resource}
      panels={panels}
      onCollapse={() => setDockCollapsed(true)}
      onModeWidthHint={dockWidthHint}
      placement="chat-dock"
      manageOwnWidth={false}
      className="w-full"
    />
  )
}

export default ArtifactDock
