"use client"

/**
 * ArtifactDock — the docked (non-modal) artifacts surface that lives in the
 * right rail of the chat workspace on desktop. Wraps the shared
 * `<ArtifactPanelContent />` with a slim header (collapse + history-rail
 * toggle) and an optional conversation-scoped artifact history rail.
 */

import {
  BotIcon,
  History,
  MessageSquareIcon,
  PanelRightClose,
  PanelsTopLeftIcon,
  SearchCodeIcon,
  InfoIcon,
  GlobeIcon,
} from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { hasWorkspaceFsBackend } from "@/lib/files/workspace-backend"
import { useChatStore } from "@/stores/chat"
import {
  DOCK_MODE_WIDTH_PERCENT,
  useArtifactDockLayoutStore,
  type DockMode,
} from "@/stores/artifact/artifact-dock-layout-store"
import { ArtifactPanelContent } from "./artifact-panel-content"
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
import { useContextWorkbenchSurfaceFlag } from "@/hooks/context-workbench/use-context-workbench-surface-flag"
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
  const enabled = useContextWorkbenchSurfaceFlag("artifact")
  // Rollback path only — ADR-0083 keeps the legacy dock reachable for one minor
  // release. With the flag on the workbench now covers *every* dock state
  // (artifact, browser and the no-artifact empty state), so the chat right rail
  // no longer swaps between an activity rail and the legacy top-tab chrome.
  if (!enabled) return <LegacyArtifactDock />
  return <DockContextWorkbench />
}

function DockContextWorkbench() {
  const activeArtifactId = useArtifactStore((state) => state.activeArtifactId)
  const dockMode = useArtifactDockLayoutStore((state) => state.dockMode)
  // The browser is session-scoped, so asking for it drops the artifact resource.
  return activeArtifactId && dockMode !== "browser" ? (
    <ArtifactContextWorkbench artifactId={activeArtifactId} />
  ) : (
    <SessionContextWorkbench />
  )
}

/**
 * Which panel the persisted dock mode maps onto. `reconcilePanels` falls back to
 * the *first* panel when a scope has no active panel yet, so the panel matching
 * the current mode is sorted first (see `modeFirstOrder`) — otherwise a fresh
 * scope activates an unrelated panel whose lifecycle hook writes `dockMode`
 * back and bounces the dock straight out of the mode the user asked for.
 */
function modeFirstOrder(panelId: string, modePanelId: string, order: number): number {
  return panelId === modePanelId ? 0 : order
}

/**
 * The dock is mounted with `manageOwnWidth={false}` — its width belongs to the
 * outer ResizablePanel — so the workbench header's narrow/wide buttons have to
 * resize the dock instead of the workbench, or they do nothing at all.
 */
function useDockWidthHint() {
  const requestDockSize = useArtifactDockLayoutStore((state) => state.requestDockSize)
  return useCallback(
    (mode: ContextPanelMode) => {
      // Focus is a full-screen takeover; it owns no dock width.
      if (mode === "focus") return
      requestDockSize(DOCK_MODE_WIDTH_PERCENT[mode])
    },
    [requestDockSize]
  )
}

export function ArtifactContextWorkbench({
  artifactId,
  mobile,
}: {
  artifactId: string
  mobile?: { open: boolean; onOpenChange: (open: boolean) => void }
}) {
  const tWorkbench = useTranslations("contextWorkbench")
  const workbenchInstanceId = useContextWorkbenchInstanceId("artifact")
  const artifact = useArtifactStore((state) => state.artifacts[artifactId])
  const unresolvedCommentCount = useContextCommentBadge("artifact", artifactId)
  const pendingReview = useArtifactStore((state) => state.pendingReviews[artifactId] ?? null)
  const hadPendingReview = useRef(false)
  const activeSessionId = useChatStore((state) => state.activeSessionId)
  const dockMode = useArtifactDockLayoutStore((state) => state.dockMode)
  const setDockMode = useArtifactDockLayoutStore((state) => state.setDockMode)
  const setDockCollapsed = useArtifactDockLayoutStore((state) => state.setDockCollapsed)
  const navigatePanel = useContextWorkbenchStore((state) => state.navigatePanel)
  const smartReveal = useContextWorkbenchStore((state) => state.smartReveal)
  const layout = useContextWorkbenchStore(
    (state) => state.layouts[`${workbenchInstanceId}::artifact:${artifactId}`]
  )
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
  const modePanelId = dockMode === "workspace" ? "workspace" : "preview"
  const dockWidthHint = useDockWidthHint()

  useEffect(() => {
    const handleSelection = (event: Event) => {
      const detail = (event as CustomEvent<{ artifactId: string; start: number; end: number }>)
        .detail
      if (detail.artifactId === artifactId) setSelectionState(detail)
    }
    window.addEventListener("artifact-context-selection", handleSelection)
    return () => window.removeEventListener("artifact-context-selection", handleSelection)
  }, [artifactId])

  useEffect(() => {
    if (layout?.activePanelId) return
    navigatePanel(
      `${workbenchInstanceId}::artifact:${artifactId}`,
      dockMode === "workspace" ? "workspace" : "preview",
      dockMode === "workspace" ? "wide" : "narrow"
    )
  }, [artifactId, dockMode, layout?.activePanelId, navigatePanel, workbenchInstanceId])

  useEffect(() => {
    const appeared = !hadPendingReview.current && pendingReview !== null
    hadPendingReview.current = pendingReview !== null
    if (appeared) {
      smartReveal(`${workbenchInstanceId}::artifact:${artifactId}`, "proposal-review", "wide")
    }
  }, [artifactId, pendingReview, smartReveal, workbenchInstanceId])

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
              navigatePanel(
                `${workbenchInstanceId}::artifact:${artifactId}`,
                "resource-chat",
                "narrow"
              )
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
          artifact ? <ArtifactReviewView artifact={artifact} panelMode="desktop" /> : null,
      },
      {
        id: "preview",
        activity: "preview-run",
        labelKey: "artifacts.dock.artifactMode",
        icon: PanelsTopLeftIcon,
        order: modeFirstOrder("preview", modePanelId, 10),
        appliesTo: (resource) => resource.kind === "artifact",
        retention: "stateful",
        onFirstActivate: () => setDockMode("artifact"),
        onRestore: () => setDockMode("artifact"),
        renderer: () => <ArtifactPanelContent panelMode="desktop" />,
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
        order: modeFirstOrder("workspace", modePanelId, 30),
        appliesTo: (resource) => resource.kind === "artifact",
        retention: "stateful",
        preferredMode: "wide",
        onFirstActivate: () => setDockMode("workspace"),
        onRestore: () => setDockMode("workspace"),
        renderer: () =>
          workspaceAvailable ? (
            <DockWorkspace activeSessionId={activeSessionId} />
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
      modePanelId,
      pendingReview,
      pendingSelectionComment,
      setDockMode,
      tWorkbench,
      textSelection,
      unresolvedCommentCount,
      workbenchInstanceId,
      workspaceAvailable,
    ]
  )

  // The id outlived its artifact (evicted by the persist cap, or cleared in
  // another tab). Fall through to the session workbench rather than the legacy
  // chrome so the dock keeps a single shell.
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
 * The dock's fallback surface: no artifact is active, or the user asked for the
 * browser. Hosts the session-scoped panels (artifact history, embedded browser,
 * workspace) inside the *same* workbench chrome the artifact surface uses, so
 * the chat right rail never changes shape.
 */
function SessionContextWorkbench() {
  const workbenchInstanceId = useContextWorkbenchInstanceId("artifact")
  const activeSessionId = useChatStore((state) => state.activeSessionId)
  const dockMode = useArtifactDockLayoutStore((state) => state.dockMode)
  const setDockMode = useArtifactDockLayoutStore((state) => state.setDockMode)
  const setDockCollapsed = useArtifactDockLayoutStore((state) => state.setDockCollapsed)
  const workspaceAvailable = hasWorkspaceFsBackend()
  const modePanelId =
    dockMode === "browser" ? "browser" : dockMode === "workspace" ? "workspace" : "history"
  const dockWidthHint = useDockWidthHint()

  // `setDockMode` also clears any pending workspace reveal, so only write when
  // the mode actually changes — a panel restoring into the mode it already owns
  // must not wipe the reveal request that routed the user here.
  const selectDockMode = useCallback(
    (mode: DockMode) => {
      if (useArtifactDockLayoutStore.getState().dockMode !== mode) setDockMode(mode)
    },
    [setDockMode]
  )

  const panels = useMemo<ContextPanelDefinition[]>(
    () => [
      {
        id: "history",
        activity: "review",
        labelKey: "artifacts.dock.showHistory",
        icon: History,
        order: modeFirstOrder("history", modePanelId, 10),
        appliesTo: (resource) => resource.kind === "session",
        retention: "stateful",
        onFirstActivate: () => selectDockMode("artifact"),
        onRestore: () => selectDockMode("artifact"),
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
        order: modeFirstOrder("browser", modePanelId, 20),
        appliesTo: (resource) => resource.kind === "session",
        retention: "stateful",
        preferredMode: "wide",
        onFirstActivate: () => selectDockMode("browser"),
        onRestore: () => selectDockMode("browser"),
        renderer: () => <BrowserPreviewPane sessionId={activeSessionId ?? undefined} />,
      },
      {
        id: "workspace",
        activity: "inspect",
        labelKey: "artifacts.dock.workspaceMode",
        icon: SearchCodeIcon,
        order: modeFirstOrder("workspace", modePanelId, 30),
        appliesTo: (resource) => resource.kind === "session",
        retention: "stateful",
        preferredMode: "wide",
        onFirstActivate: () => selectDockMode("workspace"),
        onRestore: () => selectDockMode("workspace"),
        renderer: () =>
          workspaceAvailable ? (
            <DockWorkspace activeSessionId={activeSessionId} />
          ) : (
            <ContextCapabilityUnavailable capability="workspace" />
          ),
      },
    ],
    [activeSessionId, modePanelId, selectDockMode, workspaceAvailable]
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

function LegacyArtifactDock() {
  const t = useTranslations("artifacts")
  const tBrowser = useTranslations("browser")
  const listRailOpen = useArtifactDockLayoutStore((s) => s.listRailOpen)
  const toggleListRail = useArtifactDockLayoutStore((s) => s.toggleListRail)
  const setDockCollapsed = useArtifactDockLayoutStore((s) => s.setDockCollapsed)
  const dockMode = useArtifactDockLayoutStore((s) => s.dockMode)
  const setDockMode = useArtifactDockLayoutStore((s) => s.setDockMode)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const workspaceAvailable = hasWorkspaceFsBackend()
  const activeArtifactId = useArtifactStore((state) => state.activeArtifactId)
  const workbenchInstanceId = useContextWorkbenchInstanceId("artifact")
  const navigatePanel = useContextWorkbenchStore((state) => state.navigatePanel)

  const selectDockMode = (mode: "artifact" | "workspace") => {
    if (activeArtifactId) {
      navigatePanel(
        `${workbenchInstanceId}::artifact:${activeArtifactId}`,
        mode === "workspace" ? "workspace" : "preview",
        mode === "workspace" ? "wide" : "narrow"
      )
    }
    setDockMode(mode)
  }

  return (
    <div
      data-testid="artifact-dock"
      className="flex h-full min-h-0 flex-col border-l bg-background"
    >
      <div className="flex items-center justify-between gap-1 border-b px-2 py-1">
        <div className="flex items-center rounded-md bg-muted p-0.5" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={dockMode === "artifact"}
            data-testid="artifact-dock-mode-artifact"
            className={cn(
              "rounded px-2 py-1 text-xs",
              dockMode === "artifact" ? "bg-background shadow-sm" : "text-muted-foreground"
            )}
            onClick={() => selectDockMode("artifact")}
          >
            {t("dock.artifactMode")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={dockMode === "browser"}
            data-testid="artifact-dock-mode-browser"
            className={cn(
              "flex items-center gap-1 rounded px-2 py-1 text-xs",
              dockMode === "browser" ? "bg-background shadow-sm" : "text-muted-foreground"
            )}
            onClick={() => setDockMode("browser")}
          >
            <GlobeIcon className="size-3" aria-hidden />
            {tBrowser("title")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={dockMode === "workspace"}
            data-testid="artifact-dock-mode-workspace"
            disabled={!workspaceAvailable}
            title={!workspaceAvailable ? t("dock.workspaceUnavailable") : undefined}
            className={cn(
              "rounded px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50",
              dockMode === "workspace" ? "bg-background shadow-sm" : "text-muted-foreground"
            )}
            onClick={() => selectDockMode("workspace")}
          >
            {t("dock.workspaceMode")}
          </button>
        </div>
        <div className="flex items-center gap-0.5">
          <TooltipProvider>
            {dockMode === "artifact" && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    data-testid="artifact-dock-history-toggle"
                    variant={listRailOpen ? "secondary" : "ghost"}
                    size="icon"
                    className="h-7 w-7"
                    aria-pressed={listRailOpen}
                    aria-label={listRailOpen ? t("dock.hideHistory") : t("dock.showHistory")}
                    onClick={toggleListRail}
                  >
                    <History className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {listRailOpen ? t("dock.hideHistory") : t("dock.showHistory")}
                </TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  data-testid="artifact-dock-collapse"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  aria-label={t("dock.collapse")}
                  title={t("dock.toggleHint")}
                  onClick={() => setDockCollapsed(true)}
                >
                  <PanelRightClose className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{t("dock.toggleHint")}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {dockMode === "artifact" && listRailOpen && (
          <div
            data-testid="artifact-dock-history-rail"
            className={cn("w-56 shrink-0 border-r overflow-hidden")}
          >
            <ArtifactList
              sessionId={activeSessionId ?? undefined}
              className="h-full"
              maxHeight="100%"
            />
          </div>
        )}
        <div className="min-h-0 min-w-0 flex-1">
          {dockMode === "artifact" ? (
            <ArtifactPanelContent panelMode="desktop" />
          ) : dockMode === "browser" ? (
            <BrowserPreviewPane sessionId={activeSessionId ?? undefined} />
          ) : (
            <DockWorkspace activeSessionId={activeSessionId} />
          )}
        </div>
      </div>
    </div>
  )
}

export default ArtifactDock
