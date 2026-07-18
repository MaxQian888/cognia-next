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
} from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { hasWorkspaceFsBackend } from "@/lib/files/workspace-backend"
import { useChatStore } from "@/stores/chat"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"
import { ArtifactPanelContent } from "./artifact-panel-content"
import { ArtifactList } from "./artifact-list"
import { DockWorkspace } from "./workspace-mode/dock-workspace"
import {
  ContextWorkbench,
  ContextWorkbenchMobileSheet,
} from "@/components/context-workbench/context-workbench"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useContextWorkbenchStore } from "@/stores/context-workbench/context-workbench-store"
import type { ContextPanelDefinition, ContextResource } from "@/types/context-workbench"
import { useContextWorkbenchSurfaceFlag } from "@/hooks/context-workbench/use-context-workbench-surface-flag"
import { ResourceWorkbenchChatPanel } from "@/components/context-workbench/resource-workbench-chat-panel"
import { ArtifactReviewView } from "./artifact-review-view"
import { ContextMetadataPanel } from "@/components/context-workbench/context-metadata-panel"
import { useContextWorkbenchInstanceId } from "@/hooks/context-workbench/use-context-workbench-instance-id"
import { ContextCommentsPanel } from "@/components/context-workbench/context-comments-panel"
import { ContextCapabilityUnavailable } from "@/components/context-workbench/context-capability-unavailable"
import { resolveContextCapabilities } from "@/lib/context-workbench/capabilities"
import { useContextCommentBadge } from "@/hooks/context-workbench/use-context-comment-badge"

export function ArtifactDock() {
  const enabled = useContextWorkbenchSurfaceFlag("artifact")
  const activeArtifactId = useArtifactStore((state) => state.activeArtifactId)
  return enabled && activeArtifactId ? (
    <ArtifactContextWorkbench artifactId={activeArtifactId} />
  ) : (
    <LegacyArtifactDock />
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
        order: 10,
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
        order: 30,
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

  if (!artifact) return mobile ? null : <LegacyArtifactDock />
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

function LegacyArtifactDock() {
  const t = useTranslations("artifacts")
  const listRailOpen = useArtifactDockLayoutStore((s) => s.listRailOpen)
  const toggleListRail = useArtifactDockLayoutStore((s) => s.toggleListRail)
  const setDockCollapsed = useArtifactDockLayoutStore((s) => s.setDockCollapsed)
  const dockMode = useArtifactDockLayoutStore((s) => s.dockMode)
  const setDockMode = useArtifactDockLayoutStore((s) => s.setDockMode)
  const activeSessionId = useChatStore((s) => s.activeSessionId)
  const workspaceAvailable = hasWorkspaceFsBackend()

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
            onClick={() => setDockMode("artifact")}
          >
            {t("dock.artifactMode")}
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
            onClick={() => setDockMode("workspace")}
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
          ) : (
            <DockWorkspace activeSessionId={activeSessionId} />
          )}
        </div>
      </div>
    </div>
  )
}

export default ArtifactDock
