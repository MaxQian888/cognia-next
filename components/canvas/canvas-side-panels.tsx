"use client"

/**
 * Canvas Side Panels — the Canvas guild's right rail, a `ContextWorkbench`
 * host (ADR-0083).
 *
 * One shell. The pre-0083 Tabs container that used to switch between
 * Suggestions / History / Comments / Collaboration / Execution is gone; each of
 * those is a panel definition below, grouped onto the shared activity rail, and
 * routing lives in `contextWorkbenchStore`. The panel *bodies* (`SuggestionsHost`,
 * `HistoryHost`, `CollaborationHost`, `ExecutionHost`, `CanvasOutlinePanel`) are
 * unchanged.
 *
 * Comments are the one surface that did change owner: the canvas-only
 * `CommentPanel` over `stores/canvas/comment-store` was superseded by the
 * cross-resource `ContextCommentsPanel` over `lib/db/context-comments`. The
 * store itself stays — `lib/plugin/api/canvas-api.ts` and `lib/canvas/dexie-bridge.ts`
 * are still its consumers.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { motion } from "motion/react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
} from "@/components/ui/empty"
import {
  Lightbulb,
  History as HistoryIcon,
  MessageSquare,
  Wand2,
  Users,
  Play,
  ListTree,
  Eye,
  InfoIcon,
} from "lucide-react"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useCanvasLayoutStore } from "@/stores/canvas/canvas-layout-store"
import { STAGGER_CHILD, STAGGER_CONTAINER } from "@/lib/ui/motion"
import { SuggestionsPanel } from "./suggestions-panel"
import { VersionHistoryPanel } from "./version-history-panel"
import { CollaborationPanel } from "./collaboration-panel"
import { CodeExecutionPanel } from "./code-execution-panel"
import { CanvasOutlinePanel, countCanvasSymbols, parseCanvasSymbols } from "./canvas-outline-panel"
import { useCanvasCodeExecution } from "@/hooks/canvas"
import { useCanvasFeatureFlag } from "@/hooks/canvas/use-canvas-feature-flag"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"
import { ContextWorkbench } from "@/components/context-workbench/context-workbench"
import { useContextWorkbenchStore } from "@/stores/context-workbench/context-workbench-store"
import type { ContextPanelDefinition, ContextResource } from "@/types/context-workbench"
import { ResourceWorkbenchChatPanel } from "@/components/context-workbench/resource-workbench-chat-panel"
import { CanvasAiPanel } from "./canvas-ai-panel"
import { CanvasReviewView } from "./canvas-review-view"
import { CanvasPreviewPane } from "./canvas-preview-pane"
import { CANVAS_EXECUTE_EVENT, type CanvasExecuteDetail } from "./canvas-execute-event"
import { ContextMetadataPanel } from "@/components/context-workbench/context-metadata-panel"
import { ContextCommentsPanel } from "@/components/context-workbench/context-comments-panel"
import { CanvasExportMenu } from "./canvas-export-menu"
import { CanvasLanguageSelect } from "./canvas-language-select"
import {
  DocumentFormatToolbar,
  type FormatAction,
} from "@/components/document/document-format-toolbar"
import { useContextWorkbenchInstanceId } from "@/hooks/context-workbench/use-context-workbench-instance-id"
import { resolveContextCapabilities } from "@/lib/context-workbench/capabilities"
import { useContextCommentBadge } from "@/hooks/context-workbench/use-context-comment-badge"
import { useCanvasCommentAnchors } from "@/hooks/canvas/use-canvas-comment-anchors"

export interface CanvasSidePanelsProps {
  mobile?: boolean
  /** The shell has shrunk this column to the activity rail. */
  railOnly?: boolean
}

export function CanvasSidePanels({ mobile = false, railOnly = false }: CanvasSidePanelsProps) {
  return <CanvasContextWorkbench mobile={mobile} railOnly={railOnly} />
}

function CanvasContextWorkbench({ mobile, railOnly }: { mobile: boolean; railOnly: boolean }) {
  const tWorkbench = useTranslations("contextWorkbench")
  const tPanels = useTranslations("canvas.panels")
  const workbenchInstanceId = useContextWorkbenchInstanceId("canvas")
  const activeId = useArtifactStore((state) => state.activeCanvasId)
  const documents = useArtifactStore((state) => state.canvasDocuments)
  const getCanvasVersions = useArtifactStore((state) => state.getCanvasVersions)
  const pendingReview = useArtifactStore((state) =>
    activeId ? (state.pendingReviews[activeId] ?? null) : null
  )
  const hadPendingReview = useRef(false)
  const activeRightTab = useCanvasLayoutStore((state) => state.activeRightTab)
  const setRightCollapsed = useCanvasLayoutStore((state) => state.setRightCollapsed)
  const setMobileRightOpen = useCanvasLayoutStore((state) => state.setMobileRightOpen)
  // `resetLayout` had lived on the store with no caller since it was written,
  // so a canvas shell dragged to an unusable split had no way back. Same entry
  // point as the chat dock's, in the workbench header's layout menu.
  const resetCanvasLayout = useCanvasLayoutStore((state) => state.resetLayout)
  const navigatePanel = useContextWorkbenchStore((state) => state.navigatePanel)
  const smartReveal = useContextWorkbenchStore((state) => state.smartReveal)
  const layouts = useContextWorkbenchStore((state) => state.layouts)
  const document = activeId ? documents[activeId] : undefined
  const unresolvedCommentCount = useContextCommentBadge("canvas-document", activeId)
  const canvasAnchors = useCanvasCommentAnchors(activeId)
  const scopeKey = activeId ? `${workbenchInstanceId}::canvas:${activeId}` : null
  const [selectionState, setSelectionState] = useState<
    { documentId: string; start: number; end: number } | undefined
  >()
  const textSelection = useMemo(
    () =>
      selectionState?.documentId === activeId
        ? { start: selectionState.start, end: selectionState.end }
        : undefined,
    [activeId, selectionState]
  )

  useEffect(() => {
    const handleSelection = (event: Event) => {
      const detail = (event as CustomEvent<{ documentId: string; start: number; end: number }>)
        .detail
      if (!activeId || detail.documentId !== activeId) return
      setSelectionState(detail.start === detail.end ? undefined : detail)
    }
    window.addEventListener("canvas-context-selection", handleSelection)
    return () => window.removeEventListener("canvas-context-selection", handleSelection)
  }, [activeId])

  useEffect(() => {
    if (!scopeKey || layouts[scopeKey]?.activePanelId) return
    navigatePanel(scopeKey, activeRightTab, "narrow")
  }, [activeRightTab, layouts, navigatePanel, scopeKey])

  useEffect(() => {
    const appeared = !hadPendingReview.current && pendingReview !== null
    hadPendingReview.current = pendingReview !== null
    if (appeared && scopeKey) {
      smartReveal(scopeKey, "proposal-review", "wide")
    }
  }, [pendingReview, scopeKey, smartReveal])

  const panels = useMemo<ContextPanelDefinition[]>(
    () => [
      {
        id: "ai-actions",
        activity: "ai",
        labelKey: "contextWorkbench.aiActions",
        icon: Wand2,
        order: 1,
        appliesTo: (resource) => resource.kind === "canvas-document",
        retention: "stateful",
        renderer: () => (activeId ? <CanvasAiPanel documentId={activeId} /> : null),
      },
      {
        id: "resource-chat",
        activity: "ai",
        labelKey: "contextWorkbench.resourceChat",
        icon: Lightbulb,
        order: 5,
        appliesTo: (resource) => resource.kind === "canvas-document",
        retention: "stateful",
        requiresChatScope: true,
        renderer: () => (
          <ResourceWorkbenchChatPanel getResourceContext={() => document?.content ?? ""} />
        ),
      },
      {
        id: "suggestions",
        activity: "ai",
        labelKey: "canvas.panels.suggestions",
        icon: Lightbulb,
        order: 10,
        appliesTo: (resource) => resource.kind === "canvas-document",
        retention: "stateful",
        getBadge: () =>
          (document?.aiSuggestions ?? []).filter((suggestion) => suggestion.status === "pending")
            .length,
        renderer: () => (activeId ? <SuggestionsHost documentId={activeId} /> : null),
      },
      {
        id: "comments",
        activity: "comments",
        labelKey: "canvas.panels.comments",
        icon: MessageSquare,
        order: 20,
        appliesTo: (resource) => resource.kind === "canvas-document",
        retention: "stateful",
        getBadge: () => unresolvedCommentCount,
        renderer: () =>
          activeId && document ? (
            <ContextCommentsPanel
              resource={{
                kind: "canvas-document",
                id: activeId,
                projectId: document.projectId,
              }}
              revision={document.currentVersionId ?? document.updatedAt.toISOString()}
              anchor={
                textSelection
                  ? {
                      kind: "text-range",
                      start: textSelection.start,
                      end: textSelection.end,
                      revision: document.currentVersionId ?? document.updatedAt.toISOString(),
                      // Present only when a shared document is open. A comment
                      // written with one follows the text it was about instead
                      // of being greyed out by the next edit anywhere above it.
                      crdt: canvasAnchors.encode(textSelection.start, textSelection.end),
                    }
                  : undefined
              }
              resolveAnchor={canvasAnchors.resolve}
            />
          ) : null,
      },
      {
        id: "collaboration",
        activity: "comments",
        labelKey: "canvas.panels.collaboration",
        icon: Users,
        order: 30,
        appliesTo: (resource) => resource.kind === "canvas-document",
        retention: "stateful",
        renderer: () => (activeId ? <CollaborationHost documentId={activeId} /> : null),
      },
      {
        id: "properties",
        activity: "inspect",
        labelKey: "contextWorkbench.metadata.canvasTitle",
        icon: InfoIcon,
        order: 35,
        appliesTo: (resource) => resource.kind === "canvas-document",
        retention: "stateful",
        renderer: () =>
          document ? (
            <div className="flex h-full min-h-0 flex-col">
              <div className="flex items-center border-b p-2">
                <CanvasLanguageSelect documentId={activeId} />
              </div>
              {document.type === "text" ? (
                <div className="border-b p-2">
                  <DocumentFormatToolbar
                    onAction={(action) =>
                      window.dispatchEvent(
                        new CustomEvent<{ action: FormatAction }>("canvas-format", {
                          detail: { action },
                        })
                      )
                    }
                    className="border-0 bg-transparent p-0 justify-start"
                  />
                </div>
              ) : null}
              <ContextMetadataPanel
                title={tWorkbench("metadata.canvasTitle")}
                fields={[
                  { label: tWorkbench("metadata.language"), value: document.language },
                  { label: tWorkbench("metadata.documentType"), value: document.type },
                  {
                    label: tWorkbench("metadata.saveState"),
                    value: document.editorContext?.saveState ?? tWorkbench("metadata.unknown"),
                  },
                  {
                    label: tWorkbench("metadata.revision"),
                    value: document.currentVersionId ?? tWorkbench("metadata.unknown"),
                  },
                  {
                    label: tWorkbench("metadata.updatedAt"),
                    value: document.updatedAt.toLocaleString(),
                  },
                ]}
              />
            </div>
          ) : null,
      },
      {
        id: "outline",
        activity: "inspect",
        labelKey: "canvas.panels.outline",
        icon: ListTree,
        order: 40,
        appliesTo: (resource) => resource.kind === "canvas-document",
        retention: "stateful",
        getBadge: () => countCanvasSymbols(parseCanvasSymbols(document)),
        renderer: () => (activeId ? <CanvasOutlinePanel documentId={activeId} /> : null),
      },
      {
        id: "proposal-review",
        activity: "review",
        labelKey: "contextWorkbench.proposalReview",
        icon: HistoryIcon,
        order: 45,
        appliesTo: (resource) => resource.kind === "canvas-document",
        retention: "stateful",
        preferredMode: "wide",
        getBadge: () => (pendingReview ? 1 : 0),
        renderer: () =>
          activeId ? <CanvasReviewView documentId={activeId} panelMode="desktop" /> : null,
      },
      {
        id: "history",
        activity: "review",
        labelKey: "canvas.panels.history",
        icon: HistoryIcon,
        order: 44,
        appliesTo: (resource) => resource.kind === "canvas-document",
        retention: "stateful",
        preferredMode: "wide",
        getBadge: () => (activeId ? getCanvasVersions(activeId).length : 0),
        renderer: () => (activeId ? <HistoryHost documentId={activeId} /> : null),
      },
      {
        id: "preview",
        activity: "preview-run",
        labelKey: "canvas.previewAction",
        icon: Eye,
        order: 50,
        appliesTo: (resource) => resource.kind === "canvas-document",
        retention: "stateful",
        preferredMode: "wide",
        renderer: () =>
          activeId ? (
            <div className="flex h-full min-h-0 flex-col">
              <div className="flex h-10 shrink-0 items-center justify-end border-b px-2">
                <CanvasExportMenu documentId={activeId} />
              </div>
              <CanvasPreviewPane documentId={activeId} className="min-h-0 flex-1" />
            </div>
          ) : null,
      },
      {
        id: "execution",
        activity: "preview-run",
        labelKey: "canvas.panels.execution",
        icon: Play,
        order: 60,
        appliesTo: (resource) => resource.kind === "canvas-document",
        retention: "stateful",
        preferredMode: "wide",
        renderer: () => (activeId ? <ExecutionHost documentId={activeId} /> : null),
      },
    ],
    [
      activeId,
      document,
      getCanvasVersions,
      pendingReview,
      tWorkbench,
      textSelection,
      unresolvedCommentCount,
      canvasAnchors,
    ]
  )

  // No document to describe, so there is no resource to build a workbench
  // around. The rail would render a row of buttons that all lead nowhere, so
  // show the hint instead — the same one the pre-workbench rail showed here.
  if (!activeId || !document) {
    return (
      <div className="flex h-full min-h-0 min-w-0 flex-col" data-testid="canvas-side-panels-empty">
        <Empty className="border-0 p-4 text-xs">
          <EmptyHeader>
            <EmptyDescription className="text-xs">{tPanels("emptyHint")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    )
  }

  const resource: ContextResource = {
    kind: "canvas-document",
    documentId: activeId,
    revision: document.currentVersionId ?? document.updatedAt.toISOString(),
    selection: textSelection
      ? { kind: "canvas", blockIds: [], text: { kind: "text", ...textSelection } }
      : undefined,
    capabilities: resolveContextCapabilities({
      kind: "canvas-document",
      runnable: document.type === "code",
    }),
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PluginExtensionSlot
        point="canvas.sidebar"
        className="flex flex-col gap-1 border-b bg-muted/20 px-2 py-1 empty:hidden"
      />
      <ContextWorkbench
        workbenchInstanceId={workbenchInstanceId}
        resource={resource}
        panels={panels}
        onCollapse={() => (mobile ? setMobileRightOpen(false) : setRightCollapsed(true))}
        onEnsureVisible={() => (mobile ? setMobileRightOpen(true) : setRightCollapsed(false))}
        railOnly={mobile ? false : railOnly}
        onResetLayout={resetCanvasLayout}
        placement={mobile ? "mobile-sheet" : "adjacent-editor"}
        manageOwnWidth={false}
        className="w-full flex-1"
      />
    </div>
  )
}

/**
 * Wraps the Cognia SuggestionsPanel with the active document's
 * suggestions list pulled from the artifact store.
 */
function SuggestionsHost({ documentId }: { documentId: string }) {
  const t = useTranslations("canvas.panels")
  const documents = useArtifactStore((s) => s.canvasDocuments)
  const doc = documents[documentId]
  const suggestions = doc?.aiSuggestions ?? []

  if (suggestions.length === 0) {
    return (
      <Empty className="h-full border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Lightbulb />
          </EmptyMedia>
          <EmptyDescription className="text-xs">{t("suggestionsEmpty")}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <SuggestionsPanel documentId={documentId} suggestions={suggestions} proposalFirst />
    </div>
  )
}

/**
 * Renders the Cognia VersionHistoryPanel as a Sheet trigger button.
 * The panel itself opens its own Sheet with full diff support.
 */
function HistoryHost({ documentId }: { documentId: string }) {
  const t = useTranslations("canvas.panels")
  const getCanvasVersions = useArtifactStore((s) => s.getCanvasVersions)
  const versions = getCanvasVersions(documentId)

  if (versions.length === 0) {
    return (
      <Empty className="h-full border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <HistoryIcon />
          </EmptyMedia>
          <EmptyDescription className="text-xs">{t("historyEmpty")}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  const recent = versions.slice(0, 3)

  return (
    <div className="flex h-full flex-col">
      <motion.div
        className="flex-1 min-h-0 overflow-y-auto p-3 space-y-1"
        variants={STAGGER_CONTAINER}
        initial="initial"
        animate="animate"
      >
        {recent.map((v) => (
          <motion.div
            key={v.id}
            variants={STAGGER_CHILD}
            className="flex items-center gap-2 text-xs text-muted-foreground py-1"
          >
            <span className="truncate flex-1">
              {v.description || new Date(v.createdAt).toLocaleString()}
            </span>
            {v.isAutoSave && (
              <Badge variant="outline" className="text-[9px] px-1 h-4 shrink-0">
                <AutoSaveTag />
              </Badge>
            )}
          </motion.div>
        ))}
        {versions.length > 3 && (
          <p className="text-[10px] text-muted-foreground/60 pt-1">
            {t("moreVersions", { count: versions.length - 3 })}
          </p>
        )}
      </motion.div>
      <div className="p-3 pt-0">
        <VersionHistoryPanel
          documentId={documentId}
          trigger={
            <Button size="sm" variant="outline" className="w-full text-xs">
              <HistoryIcon className="mr-2 size-3.5" />
              {t("openHistory", { default: "Open full history" })}
              <span className="ml-1 opacity-60">({versions.length})</span>
            </Button>
          }
        />
      </div>
    </div>
  )
}

function AutoSaveTag() {
  const tRoot = useTranslations("canvas")
  return <>{tRoot("autoTag")}</>
}

/**
 * Mounts the Cognia CollaborationPanel content inline so the user
 * can see participants + connection state directly in the right rail.
 */
function CollaborationHost({ documentId }: { documentId: string }) {
  const t = useTranslations("canvas.panels")
  // Feature-flag gate: `canvas.collaboration.v1` (env / localStorage override).
  // When disabled, the panel shows the hint but no "open collaboration" entry.
  const collaborationEnabled = useCanvasFeatureFlag("canvas.collaboration.v1")
  const documents = useArtifactStore((s) => s.canvasDocuments)
  const doc = documents[documentId]
  return (
    <Empty className="h-full border-0">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Users />
        </EmptyMedia>
        <EmptyDescription className="text-xs">{t("collabHint")}</EmptyDescription>
      </EmptyHeader>
      {collaborationEnabled && (
        <EmptyContent>
          <CollaborationPanel
            documentId={documentId}
            documentContent={doc?.content ?? ""}
            trigger={
              <Button size="sm" variant="outline" className="text-xs">
                <Users className="mr-2 size-3.5" />
                {t("openCollab", { default: "Open collaboration" })}
              </Button>
            }
          />
        </EmptyContent>
      )}
    </Empty>
  )
}

/**
 * Mounts the Cognia CodeExecutionPanel inline. The hook performs the
 * sandboxed run via `lib/native/code-execution-strategy.ts` which
 * routes JS to an iframe and Python through the Tauri sidecar.
 */
function ExecutionHost({ documentId }: { documentId: string }) {
  const documents = useArtifactStore((s) => s.canvasDocuments)
  const doc = documents[documentId]
  const language = doc?.language ?? "javascript"
  const { execute, cancel, clear, result, isExecuting, showOutput, availabilityFor } =
    useCanvasCodeExecution()
  const availability = availabilityFor(language)

  const run = useCallback(() => {
    const current = useArtifactStore.getState().canvasDocuments[documentId]
    if (!current) return
    void execute(current.content, current.language)
  }, [documentId, execute])

  // The `run` AI action delegates here rather than asking a model to describe
  // what it thinks the code would do. Reading the document from the store at
  // call time keeps the run on the newest buffer even when the event arrives
  // from the editor pane a beat after a commit.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<CanvasExecuteDetail>).detail
      if (detail?.documentId !== documentId) return
      run()
    }
    window.addEventListener(CANVAS_EXECUTE_EVENT, handler as EventListener)
    return () => window.removeEventListener(CANVAS_EXECUTE_EVENT, handler as EventListener)
  }, [documentId, run])

  return (
    <CodeExecutionPanel
      code={doc?.content ?? ""}
      result={result}
      isExecuting={isExecuting}
      language={language}
      onExecute={run}
      onCancel={() => cancel()}
      onClear={() => clear()}
      unavailableReason={availability.reason}
      showOutput={showOutput}
      className="border-t-0"
    />
  )
}
